import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOfferOperationStore } from "./offer-operation-store";

const storage = new Map<string, unknown>();
const getTab = vi.fn();
const removeTab = vi.fn();

beforeEach(() => {
  storage.clear();
  getTab.mockReset();
  removeTab.mockReset();

  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) storage.set(key, value);
        }),
        remove: vi.fn(async (key: string) => storage.delete(key)),
      },
    },
    tabs: {
      get: getTab,
      remove: removeTab,
    },
  });
});

describe("background offer operation store", () => {
  it("enforces a single issuer operation globally", async () => {
    const store = createOfferOperationStore();
    const chase = await store.start("chase");
    const amex = await store.start("amex");
    expect(chase.ok).toBe(true);
    expect(amex.ok).toBe(false);
    if (!amex.ok) expect(amex.busy).toBe("chase");
  });

  it("enforces the global lock when starts race", async () => {
    const store = createOfferOperationStore();
    const [chase, amex] = await Promise.all([
      store.start("chase"),
      store.start("amex"),
    ]);
    expect([chase.ok, amex.ok].filter(Boolean)).toHaveLength(1);
  });

  it("rejects a late run id and keeps the active operation intact", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("chase");
    expect(await store.patch("late-run", { phase: "failed" })).toBeNull();
    expect((await store.getSnapshot()).active?.runId).toBe(started.state.runId);
  });

  it("marks an operation interrupted when its owned tab is missing", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("citi");
    await store.patch(started.state.runId, {
      phase: "waiting_for_login",
      ownedTabId: 42,
    });
    getTab.mockRejectedValue(new Error("missing"));

    const snapshot = await store.getSnapshot();
    expect(snapshot.active).toBeNull();
    expect(snapshot.history.citi?.phase).toBe("interrupted");
  });

  it("records remaining work when cancellation happens mid-enrollment", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("amex");
    await store.patch(started.state.runId, { phase: "checking" });
    await store.patch(started.state.runId, { phase: "ready_to_add" });
    await store.patch(started.state.runId, {
      phase: "adding",
      total: 18,
      added: 6,
      failed: 0,
    });
    const cancelled = await store.cancel(started.state.runId);
    expect(cancelled?.remaining).toBe(12);
    expect(cancelled?.phase).toBe("cancelled");
  });

  it("ignores late progress after completion and still updates save status", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("chase");
    getTab.mockResolvedValue({ id: 42 });
    await store.patch(started.state.runId, {
      phase: "checking",
      ownedTabId: 42,
    });
    await store.markReady(started.state.runId, [{
      key: "card-1",
      name: "Sapphire",
      lastDigits: "1234",
      availableCount: 32,
      countStatus: "complete",
    }]);
    await store.beginEnrollment(started.state.runId, ["card-1"], 32);
    await store.patchActiveRun("chase", started.state.runId, {
      phase: "completed",
      added: 32,
      remaining: 0,
      saveStatus: "saving",
    });

    expect(
      await store.patchActiveRun("chase", started.state.runId, {
        phase: "adding",
        added: 32,
      }),
    ).toBeNull();

    await store.patch(started.state.runId, { saveStatus: "saved" });
    const snapshot = await store.getSnapshot();
    expect(snapshot.active).toBeNull();
    expect(snapshot.history.chase?.phase).toBe("completed");
    expect(snapshot.history.chase?.saveStatus).toBe("saved");
  });

  it("keeps remaining cards actionable after a saved enrollment", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("chase");
    getTab.mockResolvedValue({ id: 42 });
    await store.patch(started.state.runId, {
      phase: "checking",
      ownedTabId: 42,
    });
    await store.markReady(started.state.runId, [
      {
        key: "sapphire",
        name: "Sapphire Reserve",
        lastDigits: "6949",
        availableCount: 104,
        countStatus: "complete",
      },
      {
        key: "freedom",
        name: "Freedom",
        lastDigits: "4055",
        availableCount: 111,
        countStatus: "complete",
      },
    ]);
    await store.beginEnrollment(started.state.runId, ["sapphire"], 104);
    await store.patchActiveRun("chase", started.state.runId, {
      phase: "completed",
      added: 104,
      remaining: 0,
      saveStatus: "saving",
    });
    await store.patch(started.state.runId, { saveStatus: "saved" });

    const continued = await store.continueAfterSavedEnrollment(
      started.state.runId,
    );
    expect(continued?.runId).not.toBe(started.state.runId);
    expect(continued).toMatchObject({
      phase: "ready_to_add",
      ownedTabId: 42,
      added: 104,
      saveStatus: "saved",
    });
    expect(continued?.cards).toEqual([
      expect.objectContaining({ key: "sapphire", availableCount: 0 }),
      expect.objectContaining({ key: "freedom", availableCount: 111 }),
    ]);
    expect((await store.getSnapshot()).active?.runId).toBe(continued?.runId);
  });

  it("refreshes every Amex card instead of reusing shared-offer counts", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("amex");
    getTab.mockResolvedValue({ id: 84 });
    await store.patch(started.state.runId, {
      phase: "checking",
      ownedTabId: 84,
    });
    await store.markReady(started.state.runId, [
      {
        key: "platinum",
        name: "Platinum",
        lastDigits: "1001",
        availableCount: 100,
        countStatus: "complete",
        sharedOfferCount: 80,
      },
      {
        key: "gold",
        name: "Gold",
        lastDigits: "1002",
        availableCount: 95,
        countStatus: "complete",
        sharedOfferCount: 80,
      },
    ]);
    await store.beginEnrollment(started.state.runId, ["platinum"], 100);
    await store.patchActiveRun("amex", started.state.runId, {
      phase: "completed",
      added: 100,
      remaining: 0,
      saveStatus: "saving",
    });
    await store.patch(started.state.runId, { saveStatus: "saved" });

    const continued = await store.continueAfterSavedEnrollment(
      started.state.runId,
    );
    expect(continued?.phase).toBe("checking");
    expect(continued?.cards).toEqual([
      expect.objectContaining({
        key: "platinum",
        availableCount: null,
        countStatus: "unknown",
        sharedOfferCount: null,
      }),
      expect.objectContaining({
        key: "gold",
        availableCount: null,
        countStatus: "unknown",
        sharedOfferCount: null,
      }),
    ]);

    await store.markReady(continued!.runId, [
      {
        key: "platinum",
        name: "Platinum",
        lastDigits: "1001",
        availableCount: 0,
        countStatus: "complete",
        sharedOfferCount: 0,
      },
      {
        key: "gold",
        name: "Gold",
        lastDigits: "1002",
        availableCount: 12,
        countStatus: "complete",
        sharedOfferCount: 0,
      },
    ]);
    const refreshed = (await store.getSnapshot()).active;
    expect(refreshed).toMatchObject({
      phase: "ready_to_add",
      added: 100,
      saveStatus: "saved",
    });
    expect(refreshed?.cards[1]).toMatchObject({
      key: "gold",
      availableCount: 12,
    });
  });

  it("repairs a persisted adding state whose work already reached its total", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("chase");
    await store.patch(started.state.runId, {
      phase: "checking",
      ownedTabId: 42,
    });
    await store.patch(started.state.runId, { phase: "ready_to_add" });
    await store.patch(started.state.runId, {
      phase: "adding",
      total: 32,
      added: 32,
      failed: 0,
      remaining: 0,
    });

    const snapshot = await store.getSnapshot();
    expect(snapshot.active).toBeNull();
    expect(snapshot.history.chase?.phase).toBe("completed");
    expect(snapshot.history.chase?.remaining).toBe(0);
  });

  it("releases stale ready results while retaining history", async () => {
    const store = createOfferOperationStore();
    const started = await store.start("chase");
    await store.patch(started.state.runId, { phase: "checking" });
    await store.markReady(started.state.runId, [{
      key: "card-1",
      name: "Sapphire",
      lastDigits: "1234",
      availableCount: 18,
      countStatus: "complete",
    }]);
    await store.patch(started.state.runId, {
      checkedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });
    const snapshot = await store.getSnapshot();
    expect(snapshot.active).toBeNull();
    expect(snapshot.history.chase?.phase).toBe("ready_to_add");
  });
});
