import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCapitalOneSync } from "./capitalone";
import { createGenericSyncHandlers } from "./generic";
import { createRuntimeStateStore } from "../core/runtime-state";
import { providerRegistry } from "../../providers/provider-registry";
import { parseCapitalOneTravelCreditSnapshot } from "./capitalone";

describe("parseCapitalOneTravelCreditSnapshot", () => {
  it("keeps the annual entitlement when the credit is fully redeemed", () => {
    expect(parseCapitalOneTravelCreditSnapshot({
      topLines: [
        "$0.00",
        "Annual travel credit",
        "Renews Sep 4, 2026",
        "Available to spend on travel",
        "$0.00",
      ],
      activityLines: [
        "VENTURE X...9917 ANNUAL TRAVEL CREDIT REDEMPTION",
        "$300.00",
        "Sep 5, 2025",
        "VENTURE X...9917 ANNUAL TRAVEL CREDIT",
        "Redeemed Feb 6, 2026",
        "+ $300.00",
      ],
    })).toEqual({
      remaining: 0,
      total: 300,
      period: "Renews Sep 4, 2026",
    });
  });

  it("calculates a partially used annual credit from the grant and balance", () => {
    expect(parseCapitalOneTravelCreditSnapshot({
      topLines: [
        "Annual travel credit",
        "Renews Jan 1, 2027",
        "Available to spend on travel",
        "$125.50",
      ],
      activityLines: [
        "VENTURE X...1234 ANNUAL TRAVEL CREDIT",
        "+ $300.00",
      ],
    })).toEqual({
      remaining: 125.5,
      total: 300,
      period: "Renews Jan 1, 2027",
    });
  });

  it("falls back to the displayed annual amount when no activity is available", () => {
    expect(parseCapitalOneTravelCreditSnapshot({
      topLines: [
        "$300.00",
        "Annual travel credit",
        "Available to spend on travel",
        "$300.00",
      ],
      activityLines: [],
    })).toEqual({
      remaining: 300,
      total: 300,
      period: null,
    });
  });
});


describe("Capital One sign-in and cancellation", () => {
  type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  type TabListener = Parameters<typeof chrome.tabs.onUpdated.addListener>[0];
  const messages = new Set<MessageListener>();
  const updates = new Set<TabListener>();
  const tab: chrome.tabs.Tab = {
    id: 42, index: 0, pinned: false, highlighted: false, windowId: 1,
    active: true, incognito: false, selected: true, discarded: false,
    autoDiscardable: true, groupId: -1, url: "https://myaccounts.capitalone.com/accountSummary",
  };
  let loginState = "mfa_challenge";
  const navigate = vi.fn();
  const extract = vi.fn();
  function emit(message: Record<string, unknown>) {
    for (const listener of [...messages]) listener(message, { tab }, () => {});
  }
  beforeEach(() => {
    vi.useFakeTimers();
    messages.clear(); updates.clear(); navigate.mockClear(); extract.mockClear();
    loginState = "mfa_challenge";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("chrome", {
      storage: { local: { set: vi.fn(async () => {}) } },
      runtime: { onMessage: {
        addListener: (listener: MessageListener) => messages.add(listener),
        removeListener: (listener: MessageListener) => messages.delete(listener),
      } },
      tabs: {
        create: vi.fn(async () => ({ id: 42 })),
        get: vi.fn(async () => ({ ...tab, status: "complete" })), update: navigate,
        onUpdated: { addListener: (listener: TabListener) => updates.add(listener), removeListener: (listener: TabListener) => updates.delete(listener) },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
        sendMessage: (_id: number, message: Record<string, unknown>, reply: (value: unknown) => void) => {
          if (message.type === "GET_LOGIN_STATE") { reply({ state: loginState }); return; }
          reply({ ok: true });
          if (message.type === "START_EXTRACTION") {
            extract();
            emit({ type: "STATUS_UPDATE", provider: "capitalone", attemptId: message.attemptId,
              status: "error", error: "Could not read the account" });
          }
        },
      },
    });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function start() {
    const stateStore = createRuntimeStateStore();
    const pushToNextCard = vi.fn(async () => ({ ok: true }));
    const options = {
      stateStore, providerRegistry, extensionNavigatingTabs: new Set<number>(), pushToNextCard,
      isProviderAttemptMessage: (message: Record<string, unknown>, provider: string, attemptId: string, type?: string) =>
        message.provider === provider && message.attemptId === attemptId && (!type || message.type === type),
    };
    const generic = createGenericSyncHandlers(options);
    const sync = createCapitalOneSync({ ...options, waitForGenericLoginAndExtract: generic.waitForGenericLoginAndExtract })();
    await vi.advanceTimersByTimeAsync(0);
    for (const listener of [...updates]) listener(42, { status: "complete" }, tab);
    await vi.advanceTimersByTimeAsync(500);
    return { sync, stateStore, pushToNextCard };
  }
  it("waits through 2FA on the account URL and only reads after verification", async () => {
    const { sync, stateStore, pushToNextCard } = await start();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(extract).not.toHaveBeenCalled();
    expect(stateStore.states.capitalone.status).toBe("waiting_for_login");
    for (const listener of [...updates]) listener(42, { status: "complete" }, { ...tab, url: "https://verified.capitalone.com/auth" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(navigate).not.toHaveBeenCalled();
    loginState = "logged_in";
    emit({ type: "LOGIN_STATE", provider: "capitalone", state: "logged_in" });
    await vi.advanceTimersByTimeAsync(3_000);
    await sync;
    expect(extract).toHaveBeenCalledTimes(1);
    expect(pushToNextCard).not.toHaveBeenCalled();
    expect(stateStore.states.capitalone.error).toBe("Could not read the account");
    expect(messages.size).toBe(0);
  });
  it("cancels the login wait and removes listeners so late verification cannot resume it", async () => {
    const { sync, stateStore, pushToNextCard } = await start();
    const run = stateStore.markRunCancelled("capitalone");
    if (!run) throw new Error("Missing sync run");
    stateStore.updateProvider("capitalone", { status: "cancelled" });
    stateStore.notifyRunCancelled("capitalone", run.attemptId);
    await sync;
    loginState = "logged_in";
    emit({ type: "LOGIN_STATE", provider: "capitalone", state: "logged_in" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(extract).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(pushToNextCard).not.toHaveBeenCalled();
    expect(messages.size).toBe(0);
    expect(updates.size).toBe(0);
  });
});
