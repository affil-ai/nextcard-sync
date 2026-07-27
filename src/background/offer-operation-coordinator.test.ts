import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOfferOperationCoordinator } from "./offer-operation-coordinator";
import { createOfferOperationStore } from "./offer-operation-store";

const storage = new Map<string, unknown>();
const getTab = vi.fn();
const removeTab = vi.fn();
const sendMessage = vi.fn();

beforeEach(() => {
  storage.clear();
  getTab.mockReset();
  removeTab.mockReset();
  sendMessage.mockReset();
  getTab.mockResolvedValue({
    id: 42,
    url: "https://secure.chase.com/web/auth/dashboard",
    status: "complete",
  });
  sendMessage.mockImplementation(
    (_tabId: number, _message: unknown, callback: (response: unknown) => void) => {
      callback({ ok: true });
    },
  );
  vi.stubGlobal("chrome", {
    runtime: { lastError: null },
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
      sendMessage,
      create: vi.fn(),
      update: vi.fn(),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
    },
  });
});

async function readyChase() {
  const store = createOfferOperationStore();
  const started = await store.start("chase");
  await store.patch(started.state.runId, {
    phase: "checking",
    ownedTabId: 42,
  });
  await store.markReady(started.state.runId, [{
    key: "card-id-1",
    name: "Sapphire",
    lastDigits: "1234",
    availableCount: 18,
    countStatus: "complete",
  }]);
  return { store, runId: started.state.runId };
}

async function readyAmex() {
  const store = createOfferOperationStore();
  const started = await store.start("amex");
  await store.patch(started.state.runId, {
    phase: "checking",
    ownedTabId: 42,
  });
  await store.markReady(started.state.runId, [
    {
      key: "amex-card-1",
      name: "Platinum",
      lastDigits: "1002",
      availableCount: 29,
      countStatus: "complete",
      sharedOfferCount: 4,
    },
    {
      key: "amex-card-2",
      name: "Blue Business Plus",
      lastDigits: "2002",
      availableCount: 72,
      countStatus: "complete",
      sharedOfferCount: 4,
    },
  ]);
  getTab.mockResolvedValue({
    id: 42,
    url: "https://global.americanexpress.com/offers",
    status: "complete",
  });
  return { store, runId: started.state.runId };
}

describe("offer operation coordinator", () => {
  it("validates and records enrollment before sending the issuer command", async () => {
    const { store, runId } = await readyChase();
    const coordinator = createOfferOperationCoordinator(store);
    const result = await coordinator.startEnrollment(runId, ["card-id-1"], 18);
    expect(result.ok).toBe(true);
    expect((await store.getSnapshot()).active?.phase).toBe("adding");
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        type: "CHASE_OFFERS_RUN",
        runId,
        cardId: "card-id-1",
      }),
      expect.any(Function),
    );
  });

  it("rejects stale enrollment without messaging the issuer", async () => {
    const { store, runId } = await readyChase();
    await store.patch(runId, {
      checkedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });
    const coordinator = createOfferOperationCoordinator(store);
    const result = await coordinator.startEnrollment(runId, ["card-id-1"], 18);
    expect(result.ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("requires a fresh Amex preflight before multi-card enrollment", async () => {
    const { store, runId } = await readyAmex();
    sendMessage.mockImplementation(
      (
        _tabId: number,
        message: unknown,
        callback: (response: unknown) => void,
      ) => {
        if ((message as { type?: string }).type === "AMEX_OFFERS_SHARED_PREFLIGHT") {
          callback({
            ok: true,
            preflightId: "preflight-1",
            matchingOfferCount: 4,
          });
          return;
        }
        callback({ ok: true });
      },
    );
    const coordinator = createOfferOperationCoordinator(store);
    const result = await coordinator.startEnrollment(
      runId,
      ["amex-card-1"],
      29,
      { addMatchingOffersAcrossCards: true },
    );

    expect(result.ok).toBe(true);
    expect(sendMessage.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      type: "AMEX_OFFERS_SHARED_PREFLIGHT",
      cardId: "amex-card-1",
    }));
    expect(sendMessage.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
      type: "AMEX_OFFERS_RUN",
      addMatchingOffersAcrossCards: true,
      sharedPreflightId: "preflight-1",
    }));
  });

  it("does not begin Amex multi-card enrollment when no shared match remains", async () => {
    const { store, runId } = await readyAmex();
    sendMessage.mockImplementation(
      (
        _tabId: number,
        _message: unknown,
        callback: (response: unknown) => void,
      ) => {
        callback({ ok: true, preflightId: "preflight-1", matchingOfferCount: 0 });
      },
    );
    const coordinator = createOfferOperationCoordinator(store);
    const result = await coordinator.startEnrollment(
      runId,
      ["amex-card-1"],
      29,
      { addMatchingOffersAcrossCards: true },
    );

    expect(result).toEqual({ ok: false, error: "no_matching_offers" });
    expect((await store.getSnapshot()).active?.phase).toBe("ready_to_add");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("requests a run-scoped stop without closing an adding tab", async () => {
    const { store, runId } = await readyChase();
    const coordinator = createOfferOperationCoordinator(store);
    await coordinator.startEnrollment(runId, ["card-id-1"], 18);
    await coordinator.cancel(runId);
    expect(sendMessage).toHaveBeenLastCalledWith(
      42,
      { type: "CHASE_OFFERS_STOP", runId },
      expect.any(Function),
    );
    expect(removeTab).not.toHaveBeenCalled();
    expect((await store.getSnapshot()).active?.cancelled).toBe(true);
  });

  it("refreshes a ready result through the owned issuer tab", async () => {
    vi.useFakeTimers();

    try {
      const { store, runId } = await readyChase();
      sendMessage.mockImplementation(
        (
          _tabId: number,
          message: unknown,
          callback: (response: unknown) => void,
        ) => {
          if ((message as { type?: string }).type === "CHASE_OFFERS_DISCOVER") {
            callback({
              cards: [{
                id: "card-id-1",
                name: "Sapphire",
                lastDigits: "1234",
              }],
              offerCounts: { "card-id-1": 20 },
            });
            return;
          }

          callback({ ok: true });
        },
      );

      const coordinator = createOfferOperationCoordinator(store);
      const result = await coordinator.refreshCheck(runId);

      expect(result.ok).toBe(true);
      expect((await store.getSnapshot()).active?.phase).toBe("checking");

      await vi.runAllTimersAsync();

      expect(sendMessage).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          type: "CHASE_OFFERS_DISCOVER",
          runId,
        }),
        expect.any(Function),
      );
      expect((await store.getSnapshot()).active?.phase).toBe("ready_to_add");
      expect(
        (await store.getSnapshot()).active?.cards[0]?.availableCount,
      ).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });
});
