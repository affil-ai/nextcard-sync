import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { providerRegistry } from "../../providers/provider-registry";
import { createRuntimeStateStore } from "./runtime-state";
import { createProviderSyncTabOpener, createSyncRunCanceller, waitForTabLoad } from "./tab-utils";

type UpdateListener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];
type RemoveListener = Parameters<typeof chrome.tabs.onRemoved.addListener>[0];
const updates = new Set<UpdateListener>();
const removals = new Set<RemoveListener>();
let tabs: chrome.tabs.Tab[];
let reserved: number[];

function tab(id: number, url: string, active = false): chrome.tabs.Tab {
  return { id, url, active, status: "complete", index: 0, pinned: false, highlighted: active,
    windowId: 1, incognito: false, selected: active, discarded: false, autoDiscardable: true, groupId: -1 };
}

beforeEach(() => {
  tabs = [];
  reserved = [];
  updates.clear(); removals.clear();
  vi.stubGlobal("chrome", {
    storage: { local: { set: vi.fn(async () => {}) } },
    runtime: {},
    tabs: {
      query: vi.fn(async () => tabs),
      get: vi.fn(async (id: number) => {
        const current = tabs.find(candidate => candidate.id === id);
        if (!current) throw new Error("Tab closed");
        return current;
      }),
      update: vi.fn(async (id: number) => tabs.find(candidate => candidate.id === id)),
      create: vi.fn(async (properties: { url: string }) => tab(99, properties.url, true)),
      remove: vi.fn(async () => {}),
      sendMessage: vi.fn((_id: number, _message: unknown, callback: (response: unknown) => void) => callback({ ok: true })),
      onUpdated: { addListener: (listener: UpdateListener) => updates.add(listener), removeListener: (listener: UpdateListener) => updates.delete(listener) },
      onRemoved: { addListener: (listener: RemoveListener) => removals.add(listener), removeListener: (listener: RemoveListener) => removals.delete(listener) },
    },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup() {
  const state = createRuntimeStateStore();
  const open = createProviderSyncTabOpener({ providerRegistry, stateStore: state, getReservedTabIds: async () => reserved });
  return { state, open, cancel: createSyncRunCanceller(state) };
}

it("prefers the active supported account page and cancellation leaves it open, even after a redirect observes it again", async () => {
  tabs = [tab(10, providerRegistry.bilt.syncUrl), tab(11, providerRegistry.bilt.syncUrl, true)];
  const { state, open, cancel } = setup();
  const { attemptId } = state.beginSyncRun("bilt");
  expect(await open("bilt", attemptId)).toBe(11);
  expect(chrome.tabs.query).toHaveBeenCalledWith({ currentWindow: true });
  expect(chrome.tabs.update).toHaveBeenCalledWith(11, { active: true });
  expect(chrome.tabs.create).not.toHaveBeenCalled();
  state.recordRunTab("bilt", attemptId, 11, { owned: true });
  expect(state.getRun("bilt")?.ownedTabId).toBeNull();
  await cancel("bilt");
  expect(chrome.tabs.remove).not.toHaveBeenCalled();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(11, { type: "ABORT_SYNC_RUN", provider: "bilt", attemptId }, expect.any(Function));
  expect(state.states.bilt.status).toBe("cancelled");
  expect(state.getRun("bilt")).toBeNull();
});

it("reuses a unique inactive account page and ignores tracking query parameters", async () => {
  tabs = [tab(10, "https://www.alaskaair.com/atmosrewards/account/overview?utm_source=test")];
  const { state, open } = setup();
  const { attemptId } = state.beginSyncRun("atmos");
  expect(await open("atmos", attemptId)).toBe(10);
  expect(state.getRun("atmos")?.ownedTabId).toBeNull();
});

it("opens an owned tab when multiple inactive account tabs make reuse ambiguous", async () => {
  tabs = [tab(10, providerRegistry.bilt.syncUrl), tab(11, providerRegistry.bilt.syncUrl)];
  const { state, open, cancel } = setup();
  const { attemptId } = state.beginSyncRun("bilt");
  expect(await open("bilt", attemptId)).toBe(99);
  await cancel("bilt");
  expect(chrome.tabs.remove).toHaveBeenCalledTimes(1);
  expect(chrome.tabs.remove).toHaveBeenCalledWith(99);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});

it.each([
  ["atmos", "https://www.alaskaair.com/booking/payment"],
  ["chase", "https://secure.chase.com/web/auth/dashboard#/dashboard/payments"],
  ["amex", "https://global.americanexpress.com/payments"],
  ["capitalone", "https://myaccounts.capitalone.com/payment"],
  ["bilt", "https://www.bilt.com/wallet?action=payment"],
  ["bilt", "https://www.bilt.com.attacker.example/wallet"],
])("does not take over a provider transaction or unrelated page (%s)", async (provider, url) => {
  const { state, open } = setup();
  if (!state.isProviderId(provider)) throw new Error("Invalid fixture provider");
  tabs = [tab(10, url, true)];
  const { attemptId } = state.beginSyncRun(provider);
  expect(await open(provider, attemptId)).toBe(99);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});

it.each(["offers", "rewards"])("skips tabs reserved by another %s operation", async kind => {
  tabs = [tab(10, providerRegistry.bilt.syncUrl, true)];
  const { state, open } = setup();
  if (kind === "offers") reserved = [10];
  else {
    const other = state.beginSyncRun("amex");
    state.recordRunTab("amex", other.attemptId, 10, { owned: true });
  }
  const { attemptId } = state.beginSyncRun("bilt");
  expect(await open("bilt", attemptId)).toBe(99);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});

it.each(["navigating", "closed"])("rechecks a candidate before using it (%s)", async reason => {
  tabs = [tab(10, providerRegistry.bilt.syncUrl, true)];
  if (reason === "closed") vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error("Tab closed"));
  else vi.mocked(chrome.tabs.get).mockResolvedValueOnce({ ...tabs[0], pendingUrl: "https://www.bilt.com/payments" });
  const { state, open } = setup();
  const { attemptId } = state.beginSyncRun("bilt");
  expect(await open("bilt", attemptId)).toBe(99);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
});

it("cancels a borrowed loading tab without closing it or leaving load listeners behind", async () => {
  tabs = [{ ...tab(10, providerRegistry.bilt.syncUrl, true), status: "loading" }];
  const { state, open, cancel } = setup();
  const { attemptId } = state.beginSyncRun("bilt");
  const pending = open("bilt", attemptId);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(updates.size).toBe(1));
  await cancel("bilt");
  await rejected;
  expect(chrome.tabs.remove).not.toHaveBeenCalled();
  expect(updates.size).toBe(0);
  expect(removals.size).toBe(0);
});

it("removes only its newly created tab when cancellation wins the create race", async () => {
  let finish: ((result: chrome.tabs.Tab) => void) | undefined;
  vi.mocked(chrome.tabs.create).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { state, open, cancel } = setup();
  const { attemptId } = state.beginSyncRun("bilt");
  const pending = open("bilt", attemptId);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(chrome.tabs.create).toHaveBeenCalled());
  await cancel("bilt");
  finish?.(tab(99, providerRegistry.bilt.syncUrl));
  await rejected;
  expect(chrome.tabs.remove).toHaveBeenCalledTimes(1);
  expect(chrome.tabs.remove).toHaveBeenCalledWith(99);
  expect(state.states.bilt.tabId).toBeNull();
});

it("recognizes a completed load even when its event happened before the listener attached", async () => {
  vi.useFakeTimers();
  tabs = [tab(10, providerRegistry.bilt.syncUrl)];
  const pending = waitForTabLoad(10);
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  expect(updates.size).toBe(0);
  expect(removals.size).toBe(0);
});

it("opens the household account tab but waits for the selected member to be ready before reading", async () => {
  tabs = [tab(10, providerRegistry.atmos.syncUrl, true)];
  const { state, open } = setup();
  state.states.atmos.syncTarget = {
    accountScopeId: "owner", memberId: "dad", memberDisplayName: "Dad", memberLifecycleVersion: 1,
    contextRevision: "revision-1", operationId: "operation-1", provider: "atmos",
  };
  const { attemptId } = state.beginSyncRun("atmos");
  let startedReading = false;
  const pending = open("atmos", attemptId).then(() => { startedReading = true; });
  await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalled());
  expect(startedReading).toBe(false);
  expect(state.states.atmos.accountPreparation?.memberDisplayName).toBe("Dad");
  expect(state.confirmAccountReady("atmos", "old-attempt")).toBe(false);
  expect(state.confirmAccountReady("atmos", attemptId)).toBe(true);
  await pending;
  expect(startedReading).toBe(true);
  expect(state.states.atmos.accountPreparation).toBeNull();
});

it.each(["cancel", "close"])("stops household preparation without starting extraction (%s)", async action => {
  tabs = [tab(10, providerRegistry.atmos.syncUrl, true)];
  const { state, open, cancel } = setup();
  state.states.atmos.syncTarget = {
    accountScopeId: "owner", memberId: "mom", memberDisplayName: "Mom", memberLifecycleVersion: 1,
    contextRevision: "revision-1", operationId: "operation-1", provider: "atmos",
  };
  const { attemptId } = state.beginSyncRun("atmos");
  const pending = open("atmos", attemptId);
  const rejected = expect(pending).rejects.toThrow(action === "cancel" ? "cancelled" : "Account tab closed");
  await vi.waitFor(() => expect(state.states.atmos.accountPreparation).toBeTruthy());
  if (action === "cancel") await cancel("atmos");
  else for (const listener of [...removals]) listener(10, { windowId: 1, isWindowClosing: false });
  await rejected;
  expect(state.confirmAccountReady("atmos", attemptId)).toBe(false);
  expect(state.states.atmos.accountPreparation).toBeNull();
  expect(removals.size).toBe(0);
  expect(chrome.tabs.remove).not.toHaveBeenCalled();
});
