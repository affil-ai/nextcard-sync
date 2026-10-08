import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { providerRegistry } from "../../providers/provider-registry";
import { createRuntimeStateStore } from "../core/runtime-state";
import { createBiltSync } from "./bilt";
import { createGenericSyncHandlers } from "./generic";

type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
type TabListener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];
const messages = new Set<MessageListener>();
const tabUpdates = new Set<TabListener>();
const readError = "Could not read Bilt rewards from this page.";
const tab: chrome.tabs.Tab = {
  id: 42, index: 0, pinned: false, highlighted: false, windowId: 1,
  active: true, incognito: false, selected: true, discarded: false,
  autoDiscardable: true, groupId: -1,
};
let initialStatus = "error";

function emitMessage(message: Record<string, unknown>) {
  for (const listener of [...messages]) {
    listener(message, { tab }, () => {});
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  initialStatus = "error";
  messages.clear();
  tabUpdates.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("chrome", {
    storage: { local: { set: vi.fn(async () => {}) } },
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => messages.add(listener),
        removeListener: (listener: MessageListener) => messages.delete(listener),
      },
    },
    tabs: {
      create: vi.fn(async () => ({ id: 42 })),
      get: vi.fn(async () => ({ id: 42, status: "complete", url: "https://www.bilt.com/wallet" })),
      onUpdated: {
        addListener: (listener: TabListener) => tabUpdates.add(listener),
        removeListener: (listener: TabListener) => tabUpdates.delete(listener),
      },
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: (_tabId: number, message: Record<string, unknown>, reply: (value: unknown) => void) => {
        if (message.type === "GET_LOGIN_STATE") {
          reply({ state: "logged_out" });
          return;
        }
        reply({ ok: true });
        emitMessage({
          type: "STATUS_UPDATE", provider: "bilt", attemptId: message.attemptId,
          status: initialStatus, error: readError,
        });
      },
    },
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function startSync() {
  const stateStore = createRuntimeStateStore();
  const pushToNextCard = vi.fn(async () => ({ ok: true }));
  const options = {
    providerRegistry,
    stateStore,
    extensionNavigatingTabs: new Set<number>(),
    isProviderAttemptMessage: (
      message: Record<string, unknown>, provider: string, attemptId: string, type?: string,
    ) => message.provider === provider && message.attemptId === attemptId
      && (!type || message.type === type),
    pushToNextCard,
  };
  const generic = createGenericSyncHandlers(options);
  const sync = createBiltSync({
    ...options,
    waitForGenericLoginAndExtract: generic.waitForGenericLoginAndExtract,
  })();
  await vi.advanceTimersByTimeAsync(0);
  for (const listener of [...tabUpdates]) {
    listener(42, { status: "complete" }, tab);
  }
  await vi.advanceTimersByTimeAsync(500);
  return { stateStore, pushToNextCard, sync };
}

describe("Bilt read-error handling", () => {
  it("surfaces an initial extraction error without reentering the login wait or saving data", async () => {
    const { stateStore, pushToNextCard, sync } = await startSync();
    await sync;
    expect(stateStore.states.bilt).toMatchObject({ status: "error", error: readError });
    expect(pushToNextCard).not.toHaveBeenCalled();
    expect(messages.size).toBe(0);
  });

  it("ignores stale failures and surfaces the current failure after waiting for sign-in", async () => {
    initialStatus = "waiting_for_login";
    const { stateStore, pushToNextCard, sync } = await startSync();
    const attemptId = stateStore.getRun("bilt")?.attemptId;
    expect(attemptId).toBeTruthy();
    emitMessage({
      type: "STATUS_UPDATE", provider: "bilt", attemptId: "stale",
      status: "error", error: "Stale failure",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stateStore.states.bilt.status).toBe("waiting_for_login");

    initialStatus = "error";
    emitMessage({ type: "LOGIN_STATE", provider: "bilt", attemptId, state: "logged_in" });
    await vi.advanceTimersByTimeAsync(3_000);
    await sync;
    expect(stateStore.states.bilt).toMatchObject({ status: "error", error: readError });
    expect(pushToNextCard).not.toHaveBeenCalled();
    expect(messages.size).toBe(0);
    expect(tabUpdates.size).toBe(0);
  });
});
