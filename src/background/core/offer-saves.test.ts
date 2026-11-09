import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageRouter } from "./message-router";
import { createRuntimeStateStore } from "./runtime-state";
import { createOfferOperationStore } from "../offer-operation-store";
import { createOfferOperationCoordinator } from "../offer-operation-coordinator";
import { providerRegistry } from "../../providers/provider-registry";
import type { OfferSaveStatus } from "../../lib/offer-operation";

beforeEach(() => {
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    tabs: { get: vi.fn(async () => ({ id: 42 })) },
  });
});

async function setup() {
  const unused = async () => { throw new Error("Unexpected unrelated handler"); };
  const store = createOfferOperationStore();
  const pending: Array<(status: OfferSaveStatus) => void> = [];
  const router = createMessageRouter({
    providerRegistry, stateStore: createRuntimeStateStore(),
    syncHandlers: { generic: unused, atmos: unused, "chase-v1": unused, amex: unused, capitalone: unused, hyatt: unused, bilt: unused },
    cancelRun: unused, startSignIn: unused, signOut: unused, getCachedAuth: unused,
    recordConsent: unused, pushToNextCard: unused, archiveRewardsAccount: unused, deleteFromNextCard: unused,
    offerOperations: store,
    offerCoordinator: createOfferOperationCoordinator(store, async () => null, async () => true),
    travelSyncCoordinator: { start: unused, getStatus: unused, cancel: unused, resetResult: unused },
    syncDetectedOffers: () => new Promise<OfferSaveStatus>((resolve) => pending.push(resolve)),
  });
  const started = await store.start("amex");
  await store.patch(started.state.runId, { phase: "checking", ownedTabId: 42 });
  function detect() {
    return new Promise<unknown>((resolve) => router({
      type: "AMEX_OFFERS_DETECTED", runId: started.state.runId, detectedOffers: [{}],
    }, {}, resolve));
  }
  return { store, pending, detect, runId: started.state.runId };
}

describe("background discovery saves", () => {
  it("finishes saving in history after Done releases the active review", async () => {
    const { store, pending, detect, runId } = await setup();
    const saving = detect();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await store.markReady(runId, []);
    expect((await store.getSnapshot()).active?.saveStatus).toBe("saving");
    await store.finishReview(runId);
    pending[0]?.("queued_for_retry");
    await saving;
    expect((await store.getSnapshot()).history.amex?.saveStatus).toBe("queued_for_retry");
  });

  it("does not hide one card's queued save when another card saves successfully", async () => {
    const { store, pending, detect } = await setup();
    const first = detect();
    const second = detect();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]?.("queued_for_retry");
    await first;
    pending[1]?.("saved");
    await second;
    expect((await store.getSnapshot()).active?.saveStatus).toBe("queued_for_retry");
  });
});
