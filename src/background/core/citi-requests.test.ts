import { beforeEach, expect, it, vi } from "vitest";
import { createMessageRouter } from "./message-router";
import { createRuntimeStateStore } from "./runtime-state";
import { createOfferOperationStore } from "../offer-operation-store";
import { createOfferOperationCoordinator } from "../offer-operation-coordinator";
import { providerRegistry, providerIds } from "../../providers/provider-registry";

const tab: chrome.tabs.Tab = { id: 42, index: 0, windowId: 1, active: true, highlighted: true, pinned: false, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1 };
const executeScript = vi.fn();
const queryTabs = vi.fn();
beforeEach(() => {
  executeScript.mockReset().mockResolvedValue([{ result: { status: 200, data: { merchantOffers: [] } } }]);
  queryTabs.mockReset().mockResolvedValue([{ id: 1, url: "https://online.citi.com/old-tab" }]);
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    tabs: { query: queryTabs, get: vi.fn(async () => tab), remove: vi.fn(async () => {}) }, scripting: { executeScript },
  });
});

function setup() {
  const unused = async () => { throw new Error("Unexpected unrelated handler"); };
  const store = createOfferOperationStore();
  const stateStore = createRuntimeStateStore();
  const cancelRun = vi.fn(async () => {});
  const router = createMessageRouter({
    providerRegistry, stateStore,
    syncHandlers: { generic: unused, atmos: unused, "chase-v1": unused, amex: unused, capitalone: unused, hyatt: unused, bilt: unused },
    cancelRun, startSignIn: unused, signOut: unused, getCachedAuth: unused,
    recordConsent: unused, pushToNextCard: unused, archiveRewardsAccount: unused, deleteFromNextCard: unused,
    offerOperations: store,
    offerCoordinator: createOfferOperationCoordinator(store, async () => null, async () => true),
    travelSyncCoordinator: { start: unused, getStatus: unused, cancel: unused, resetResult: unused },
  });
  const request = (sender: chrome.runtime.MessageSender) => new Promise<unknown>(resolve => router({
    type: "CITI_OFFERS_FETCH", method: "GET",
    url: "https://online.citi.com/gcgapi/prod/public/v1/example",
  }, sender, resolve));
  return { request, router, store, stateStore, cancelRun };
}

it("uses the requesting tab even with a different Citi tab already open", async () => {
  expect(await setup().request({ tab, url: "https://online.citi.com/US/ag/products-offers/merchantoffers" })).toMatchObject({ status: 200 });
  expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 42 } }));
  expect(queryTabs).not.toHaveBeenCalled();
});

it.each([{}, { tab, url: "https://example.com/" }])("rejects a missing or non-Citi sender without switching tabs", async sender => {
  expect(await setup().request(sender)).toMatchObject({ status: 0 });
  expect(executeScript).not.toHaveBeenCalled();
  expect(queryTabs).not.toHaveBeenCalled();
});

it("reports a closed or unavailable requesting tab without falling back to another session", async () => {
  executeScript.mockRejectedValueOnce(new Error("No tab with id 42"));
  expect(await setup().request({ tab, url: "https://online.citi.com/" })).toMatchObject({ status: 0, data: null });
  expect(queryTabs).not.toHaveBeenCalled();
});

it("scopes the waiting banner to its Citi offer run and releases it after review or cancellation", async () => {
  const { router, store } = setup();
  const started = await store.start("citi");
  const runId = started.state.runId;
  await store.patch(runId, { phase: "waiting_for_login", ownedTabId: 42 });
  const readStatus = (sender: chrome.runtime.MessageSender, requestedRun = runId) => new Promise<unknown>(resolve => router({ type: "GET_PAGE_OVERLAY_STATUS", operationId: requestedRun, provider: "citi", kind: "offers" }, sender, resolve));
  expect(await readStatus({ tab })).toMatchObject({ status: "waiting_for_login", provider: "citi", kind: "offers" });
  expect(await readStatus({ tab: { ...tab, id: 99 } })).toEqual({ status: "idle" });
  expect(await readStatus({ tab }, "old-run")).toEqual({ status: "idle" });
  await store.patch(runId, { phase: "checking" });
  expect(await readStatus({ tab })).toMatchObject({ status: "extracting" });
  await store.markReady(runId, []);
  expect(await readStatus({ tab })).toEqual({ status: "idle" });
  await store.cancel(runId, true);
  expect(await readStatus({ tab })).toEqual({ status: "idle" });
});

it.each(providerIds)("binds the %s rewards banner and cancellation to the current tab and attempt", async provider => {
  const { router, stateStore, cancelRun } = setup();
  const run = stateStore.beginSyncRun(provider);
  stateStore.setTabId(provider, 42);
  await stateStore.updateProvider(provider, { status: "waiting_for_login" });
  const request = (message: Record<string, unknown>, senderTab = tab) => new Promise<unknown>(resolve => router(message, { tab: senderTab }, resolve));
  const statusMessage = { type: "GET_PAGE_OVERLAY_STATUS" };
  expect(await request(statusMessage)).toMatchObject({ provider, kind: "rewards", operationId: run.attemptId, status: "waiting_for_login" });
  expect(await request(statusMessage, { ...tab, id: 99 })).toEqual({ status: "idle" });
  stateStore.setLoginState(provider, "mfa_challenge");
  expect(await request(statusMessage)).toMatchObject({ status: "mfa_challenge" });
  await stateStore.updateProvider(provider, { accountPreparation: { attemptId: run.attemptId, memberDisplayName: "Member" } });
  expect(await request(statusMessage)).toMatchObject({ status: "account_check" });
  const cancelMessage = { type: "CANCEL_PAGE_OVERLAY_OPERATION", provider, kind: "rewards", operationId: run.attemptId };
  expect(await request({ ...cancelMessage, operationId: "stale-run" })).toEqual({ ok: false });
  expect(cancelRun).not.toHaveBeenCalled();
  expect(await request(cancelMessage, { ...tab, id: 99 })).toEqual({ ok: false });
  expect(await request(cancelMessage)).toEqual({ ok: true });
  expect(cancelRun).toHaveBeenCalledWith(provider);
});

it.each(["chase", "amex", "capitalone", "citi"])("shows the %s offer banner and cancels offers rather than rewards", async provider => {
  const { router, store, cancelRun } = setup();
  if (provider !== "chase" && provider !== "amex" && provider !== "capitalone" && provider !== "citi") throw new Error("Unknown fixture");
  const started = await store.start(provider);
  await store.patch(started.state.runId, { phase: "waiting_for_login", ownedTabId: 42 });
  const request = (message: Record<string, unknown>) => new Promise<unknown>(resolve => router(message, { tab }, resolve));
  expect(await request({ type: "GET_PAGE_OVERLAY_STATUS" })).toMatchObject({ provider, kind: "offers", status: "waiting_for_login" });
  expect(await request({ type: "CANCEL_PAGE_OVERLAY_OPERATION", provider, kind: "offers", operationId: started.state.runId })).toEqual({ ok: true });
  expect((await store.getSnapshot()).history[provider]?.phase).toBe("cancelled");
  expect(cancelRun).not.toHaveBeenCalled();
});
