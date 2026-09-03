import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HouseholdSyncTarget } from "../../lib/household-context";
import { createRuntimeStateStore } from "./runtime-state";

const stored = new Map<string, unknown>();

beforeEach(() => {
  stored.clear();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested.flatMap((key) =>
              stored.has(key) ? [[key, stored.get(key)]] : [],
            ),
          );
        },
        async set(values: Record<string, unknown>) {
          for (const [key, value] of Object.entries(values)) {
            stored.set(key, value);
          }
        },
      },
    },
  });
});

describe("runtime household state", () => {
  it("restores a frozen first-sync target after a service-worker restart", async () => {
    const scope = {
      accountScopeId: "account-a",
      memberId: "member-a",
      isPrimary: false,
    };
    const target = {
      accountScopeId: scope.accountScopeId,
      memberId: scope.memberId,
      memberDisplayName: "Family member",
      provider: "united",
      contextRevision: "revision-1",
      operationId: "operation-1",
    } satisfies HouseholdSyncTarget;
    const firstWorker = createRuntimeStateStore();
    await firstWorker.setHouseholdScope(scope);
    await firstWorker.updateProvider("united", { syncTarget: target });

    const restartedWorker = createRuntimeStateStore();
    await restartedWorker.setHouseholdScope(scope);

    expect(restartedWorker.states.united.syncTarget).toEqual(target);
    expect(restartedWorker.states.united.status).toBe("idle");
  });

  it("does not reset state when the same scope is selected again", async () => {
    const scope = {
      accountScopeId: "account-a",
      memberId: "member-a",
      isPrimary: false,
    };
    const state = createRuntimeStateStore();
    await state.setHouseholdScope(scope);
    state.updateProvider("united", { status: "done" });

    await state.setHouseholdScope(scope);

    expect(state.states.united.status).toBe("done");
  });

  it("keeps an owner confirmation pending across a service-worker restart", async () => {
    const scope = {
      accountScopeId: "account-a",
      memberId: "member-a",
      isPrimary: false,
    };
    const target = {
      accountScopeId: scope.accountScopeId,
      memberId: scope.memberId,
      memberDisplayName: "Family member",
      provider: "atmos",
      contextRevision: "revision-1",
      operationId: "operation-1",
    } satisfies HouseholdSyncTarget;
    const firstWorker = createRuntimeStateStore();
    await firstWorker.setHouseholdScope(scope);
    await firstWorker.updateProvider("atmos", {
      status: "awaiting_confirmation",
      syncTarget: target,
      error: null,
      pendingBackendPush: false,
    });

    const restartedWorker = createRuntimeStateStore();
    await restartedWorker.setHouseholdScope(scope);

    expect(restartedWorker.states.atmos.status).toBe("awaiting_confirmation");
    expect(restartedWorker.states.atmos.error).toBeNull();
    expect(restartedWorker.states.atmos.syncTarget).toEqual(target);
  });
});
