import { describe, expect, it, vi } from "vitest";

import type { ProviderId } from "../lib/types";
import {
  TRAVEL_SYNC_RESULT_FRESHNESS_MS,
  TRAVEL_SYNC_STORAGE_KEY,
  createTravelSyncCoordinator,
} from "./travel-sync-coordinator";

function createStorage(initial?: unknown) {
  const values: Record<string, unknown> = initial === undefined
    ? {}
    : { [TRAVEL_SYNC_STORAGE_KEY]: initial };
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(values, patch);
    }),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
}

function isProviderId(value: unknown): value is ProviderId {
  return value === "aa" || value === "marriott" || value === "hilton";
}

async function waitForStatus(
  coordinator: ReturnType<typeof createTravelSyncCoordinator>,
  expected: "complete" | "cancelled",
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await coordinator.getStatus();
    if (state.status === expected) return state;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Travel sync never reached ${expected}`);
}

describe("travel sync coordinator", () => {
  it("persists progress, runs sequentially, and continues after failure", async () => {
    const storage = createStorage();
    const events: string[] = [];
    const coordinator = createTravelSyncCoordinator({
      storage,
      isProviderId,
      prepareProvider: async (providerId) => {
        events.push(`prepare:${providerId}`);
      },
      startProvider: async (providerId) => {
        events.push(`start:${providerId}`);
        return true;
      },
      waitForCompletion: async (providerId) => {
        events.push(`finish:${providerId}`);
        return { succeeded: providerId !== "aa" };
      },
      cancelProvider: vi.fn(async () => {}),
    });

    await coordinator.start(["aa", "marriott"]);
    const state = await waitForStatus(coordinator, "complete");

    expect(events).toEqual([
      "prepare:aa",
      "start:aa",
      "finish:aa",
      "prepare:marriott",
      "start:marriott",
      "finish:marriott",
    ]);
    expect(state).toMatchObject({
      status: "complete",
      processedCount: 2,
      failedCount: 1,
      currentProviderId: null,
    });
    expect(storage.set).toHaveBeenCalled();
  });

  it("resumes the current provider after a worker restart", async () => {
    const storage = createStorage({
      status: "running",
      providerIds: ["aa", "marriott"],
      currentProviderId: "marriott",
      processedCount: 1,
      failedCount: 1,
      startedAt: "2026-08-31T10:00:00.000Z",
      updatedAt: "2026-08-31T10:01:00.000Z",
      cancelRequested: false,
    });
    const started: ProviderId[] = [];
    const coordinator = createTravelSyncCoordinator({
      storage,
      isProviderId,
      startProvider: async (providerId) => {
        started.push(providerId);
        return true;
      },
      waitForCompletion: async () => ({ succeeded: true }),
      cancelProvider: vi.fn(async () => {}),
    });

    await coordinator.resume();
    const state = await waitForStatus(coordinator, "complete");

    expect(started).toEqual(["marriott"]);
    expect(state.processedCount).toBe(2);
    expect(state.failedCount).toBe(1);
  });

  it("uses one resume loop when startup and status requests race", async () => {
    const storage = createStorage({
      status: "running",
      providerIds: ["aa"],
      currentProviderId: "aa",
      processedCount: 0,
      failedCount: 0,
      startedAt: "2026-08-31T10:00:00.000Z",
      updatedAt: "2026-08-31T10:01:00.000Z",
      cancelRequested: false,
    });
    let finish = (_value: { succeeded: boolean }) => {};
    const completion = new Promise<{ succeeded: boolean }>((resolve) => {
      finish = resolve;
    });
    const startProvider = vi.fn(async () => true);
    const coordinator = createTravelSyncCoordinator({
      storage,
      isProviderId,
      startProvider,
      waitForCompletion: () => completion,
      cancelProvider: vi.fn(async () => {}),
    });

    await Promise.all([coordinator.resume(), coordinator.getStatus()]);
    await vi.waitFor(() => expect(startProvider).toHaveBeenCalledTimes(1));
    expect(storage.get).toHaveBeenCalledTimes(1);
    finish({ succeeded: true });
    await waitForStatus(coordinator, "complete");
  });

  it("honors a persisted cancellation before resuming any provider", async () => {
    const storage = createStorage({
      status: "running",
      providerIds: ["aa", "marriott"],
      currentProviderId: "aa",
      processedCount: 0,
      failedCount: 0,
      startedAt: "2026-08-31T10:00:00.000Z",
      updatedAt: "2026-08-31T10:01:00.000Z",
      cancelRequested: true,
    });
    const startProvider = vi.fn(async () => true);
    const coordinator = createTravelSyncCoordinator({
      storage,
      isProviderId,
      startProvider,
      waitForCompletion: vi.fn(async () => ({ succeeded: true })),
      cancelProvider: vi.fn(async () => {}),
    });

    await coordinator.resume();
    const state = await waitForStatus(coordinator, "cancelled");

    expect(startProvider).not.toHaveBeenCalled();
    expect(state.processedCount).toBe(0);
  });

  it("cancels the current provider and never starts a later provider", async () => {
    const storage = createStorage();
    let completeCurrent: ((value: { succeeded: boolean }) => void) | null = null;
    const cancelProvider = vi.fn(async () => {
      completeCurrent?.({ succeeded: false });
    });
    const started: ProviderId[] = [];
    const coordinator = createTravelSyncCoordinator({
      storage,
      isProviderId,
      startProvider: async (providerId) => {
        started.push(providerId);
        return true;
      },
      waitForCompletion: () => new Promise((resolve) => {
        completeCurrent = resolve;
      }),
      cancelProvider,
    });

    await coordinator.start(["aa", "marriott"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await coordinator.cancel();
    const state = await waitForStatus(coordinator, "cancelled");

    expect(cancelProvider).toHaveBeenCalledWith("aa");
    expect(started).toEqual(["aa"]);
    expect(state.processedCount).toBe(1);
    expect(state.failedCount).toBe(1);
  });

  it("cancels a provider that starts after cancellation was requested", async () => {
    const storage = createStorage();
    let finishStart = (_started: boolean) => {};
    const startProvider = vi.fn(() => new Promise<boolean>((resolve) => {
      finishStart = resolve;
    }));
    const cancelProvider = vi.fn(async () => {});
    const waitForCompletion = vi.fn(async () => ({ succeeded: true }));
    const coordinator = createTravelSyncCoordinator({
      storage,
      isProviderId,
      startProvider,
      waitForCompletion,
      cancelProvider,
    });

    await coordinator.start(["aa", "marriott"]);
    await vi.waitFor(() => expect(startProvider).toHaveBeenCalledOnce());
    const cancellation = coordinator.cancel();
    await vi.waitFor(() => expect(cancelProvider).toHaveBeenCalledOnce());
    finishStart(true);
    await cancellation;

    const state = await waitForStatus(coordinator, "cancelled");
    expect(cancelProvider).toHaveBeenCalledTimes(2);
    expect(waitForCompletion).not.toHaveBeenCalled();
    expect(state.processedCount).toBe(0);
  });

  it("expires terminal status after one hour", async () => {
    const updatedAt = "2026-08-31T10:00:00.000Z";
    const updatedAtMs = Date.parse(updatedAt);
    const storage = createStorage({
      status: "complete",
      providerIds: ["aa"],
      currentProviderId: null,
      processedCount: 1,
      failedCount: 0,
      startedAt: updatedAt,
      updatedAt,
      cancelRequested: false,
    });
    const coordinator = createTravelSyncCoordinator({
      storage,
      isProviderId,
      startProvider: vi.fn(async () => true),
      waitForCompletion: vi.fn(async () => ({ succeeded: true })),
      cancelProvider: vi.fn(async () => {}),
      now: () => updatedAtMs + TRAVEL_SYNC_RESULT_FRESHNESS_MS + 1,
    });

    expect(await coordinator.getStatus()).toMatchObject({ status: "idle" });
    expect(storage.remove).toHaveBeenCalledWith(TRAVEL_SYNC_STORAGE_KEY);
  });
});
