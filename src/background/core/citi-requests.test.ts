import { beforeEach, expect, it, vi } from "vitest";
import { createMessageRouter } from "./message-router";
import { createRuntimeStateStore } from "./runtime-state";
import { createOfferOperationStore } from "../offer-operation-store";
import { createOfferOperationCoordinator } from "../offer-operation-coordinator";
import { providerRegistry } from "../../providers/provider-registry";

const tab: chrome.tabs.Tab = { id: 42, index: 0, windowId: 1, active: true, highlighted: true, pinned: false, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1 };
const executeScript = vi.fn();
const queryTabs = vi.fn();
beforeEach(() => {
  executeScript.mockReset().mockResolvedValue([{ result: { status: 200, data: { merchantOffers: [] } } }]);
  queryTabs.mockReset().mockResolvedValue([{ id: 1, url: "https://online.citi.com/old-tab" }]);
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    tabs: { query: queryTabs }, scripting: { executeScript },
  });
});

function setup() {
  const unused = async () => { throw new Error("Unexpected unrelated handler"); };
  const store = createOfferOperationStore();
  const router = createMessageRouter({
    providerRegistry, stateStore: createRuntimeStateStore(),
    syncHandlers: { generic: unused, atmos: unused, "chase-v1": unused, amex: unused, capitalone: unused, hyatt: unused, bilt: unused },
    cancelRun: unused, startSignIn: unused, signOut: unused, getCachedAuth: unused,
    recordConsent: unused, pushToNextCard: unused, archiveRewardsAccount: unused, deleteFromNextCard: unused,
    offerOperations: store,
    offerCoordinator: createOfferOperationCoordinator(store, async () => null, async () => true),
    travelSyncCoordinator: { start: unused, getStatus: unused, cancel: unused, resetResult: unused },
  });
  return (sender: chrome.runtime.MessageSender) => new Promise<unknown>(resolve => router({
    type: "CITI_OFFERS_FETCH", method: "GET",
    url: "https://online.citi.com/gcgapi/prod/public/v1/example",
  }, sender, resolve));
}

it("uses the requesting tab even with a different Citi tab already open", async () => {
  expect(await setup()({ tab, url: "https://online.citi.com/US/ag/products-offers/merchantoffers" })).toMatchObject({ status: 200 });
  expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 42 } }));
  expect(queryTabs).not.toHaveBeenCalled();
});

it.each([{}, { tab, url: "https://example.com/" }])("rejects a missing or non-Citi sender without switching tabs", async sender => {
  expect(await setup()(sender)).toMatchObject({ status: 0 });
  expect(executeScript).not.toHaveBeenCalled();
  expect(queryTabs).not.toHaveBeenCalled();
});

it("reports a closed or unavailable requesting tab without falling back to another session", async () => {
  executeScript.mockRejectedValueOnce(new Error("No tab with id 42"));
  expect(await setup()({ tab, url: "https://online.citi.com/" })).toMatchObject({ status: 0, data: null });
  expect(queryTabs).not.toHaveBeenCalled();
});
