import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentHouseholdOperationScope } from "../lib/household-context";
import {
  clearInjectedOfferAlerts,
  initializeMerchantOfferAlertMonitor,
  registerMerchantOfferAlertMonitor,
} from "./merchant-offer-alerts";

vi.mock("../lib/household-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/household-context")>();
  return {
    ...actual,
    getCurrentHouseholdOperationScope: vi.fn(),
  };
});

const primaryScope = {
  accountScopeId: "account:owner-a",
  memberId: "member-primary",
  memberDisplayName: "Vishal",
  memberLifecycleVersion: 1,
  contextRevision: "revision-1",
};

beforeEach(() => {
  vi.mocked(getCurrentHouseholdOperationScope).mockReset();
});

describe("merchant offer alerts", () => {
  it("clears pre-upgrade toasts before registering startup listeners", async () => {
    const order: string[] = [];
    let queryCount = 0;
    vi.stubGlobal("chrome", {
      scripting: {
        executeScript: vi.fn(async () => { order.push("clear"); }),
      },
      tabs: {
        query: vi.fn((_query, callback?: (tabs: chrome.tabs.Tab[]) => void) => {
          queryCount += 1;
          if (queryCount === 1) return Promise.resolve([{ id: 11 }]);
          callback?.([]);
          return Promise.resolve([]);
        }),
        get: vi.fn(),
        onUpdated: {
          addListener: vi.fn(() => { order.push("register"); }),
        },
        onActivated: { addListener: vi.fn() },
      },
    });

    await initializeMerchantOfferAlertMonitor();

    expect(order).toEqual(["clear", "register"]);
  });

  it("removes injected offer alerts from open tabs when the profile changes", async () => {
    const executeScript = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      tabs: { query: vi.fn(async () => [{ id: 11 }, { id: 22 }, {}]) },
    });

    await clearInjectedOfferAlerts();

    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 11 },
    }));
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 22 },
    }));
  });

  it("does not inject an old member offer after the selected member changes", async () => {
    vi.mocked(getCurrentHouseholdOperationScope)
      .mockResolvedValueOnce(primaryScope)
      .mockResolvedValueOnce({ ...primaryScope, memberId: "member-secondary" });
    let onUpdated: ((tabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => void)
      | undefined;
    let resolveStorage: ((value: Record<string, unknown>) => void) | undefined;
    const storageRead = new Promise<Record<string, unknown>>((resolve) => {
      resolveStorage = resolve;
    });
    const executeScript = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => path },
      storage: { local: { get: vi.fn(() => storageRead) } },
      scripting: { executeScript },
      tabs: {
        query: vi.fn((_query, callback) => callback([])),
        get: vi.fn(),
        onUpdated: { addListener: vi.fn((listener) => { onUpdated = listener; }) },
        onActivated: { addListener: vi.fn() },
      },
    });
    registerMerchantOfferAlertMonitor();

    onUpdated?.(42, { status: "complete" }, {
      id: 42,
      active: true,
      autoDiscardable: true,
      discarded: false,
      groupId: -1,
      highlighted: true,
      incognito: false,
      index: 0,
      pinned: false,
      selected: true,
      status: "complete",
      url: "https://example.com/products",
      windowId: 1,
    });
    await vi.waitFor(() => {
      expect(getCurrentHouseholdOperationScope).toHaveBeenCalledTimes(1);
    });
    resolveStorage?.({
      "offerUrlCache::account%3Aowner-a::member-primary::1": {
        "example.com": [{
          merchantName: "Example",
          offerValue: "$5 back",
          cardName: "Sapphire",
          cardLastDigits: "1234",
          expirationDate: null,
          issuer: "chase",
          rewardType: "flat_cash",
          rewardAmount: 5,
        }],
      },
    });

    await vi.waitFor(() => {
      expect(getCurrentHouseholdOperationScope).toHaveBeenCalledTimes(2);
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("does not inject an old account offer when logout happens during the read", async () => {
    vi.mocked(getCurrentHouseholdOperationScope)
      .mockResolvedValueOnce(primaryScope)
      .mockResolvedValueOnce(null);
    let onUpdated: ((tabId: number, changeInfo: { status?: string }, tab: chrome.tabs.Tab) => void)
      | undefined;
    let resolveStorage: ((value: Record<string, unknown>) => void) | undefined;
    const storageRead = new Promise<Record<string, unknown>>((resolve) => {
      resolveStorage = resolve;
    });
    const executeScript = vi.fn();
    const queryTabs = vi.fn((...args: unknown[]) => {
      const callback = args[1];
      if (typeof callback === "function") callback([]);
      return Promise.resolve([]);
    });
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => path },
      storage: { local: { get: vi.fn(() => storageRead) } },
      scripting: { executeScript },
      tabs: {
        query: queryTabs,
        get: vi.fn(),
        onUpdated: { addListener: vi.fn((listener) => { onUpdated = listener; }) },
        onActivated: { addListener: vi.fn() },
      },
    });
    registerMerchantOfferAlertMonitor();
    onUpdated?.(42, { status: "complete" }, {
      id: 42,
      active: true,
      autoDiscardable: true,
      discarded: false,
      groupId: -1,
      highlighted: true,
      incognito: false,
      index: 0,
      pinned: false,
      selected: true,
      status: "complete",
      url: "https://example.com/products",
      windowId: 1,
    });
    await vi.waitFor(() => {
      expect(getCurrentHouseholdOperationScope).toHaveBeenCalledTimes(1);
    });
    await clearInjectedOfferAlerts();
    resolveStorage?.({
      "offerUrlCache::account%3Aowner-a::member-primary::1": {
        "example.com": [{
          merchantName: "Example",
          offerValue: "$5 back",
          cardName: "Sapphire",
          cardLastDigits: "1234",
          expirationDate: null,
          issuer: "chase",
          rewardType: "flat_cash",
          rewardAmount: 5,
        }],
      },
    });

    await vi.waitFor(() => {
      expect(getCurrentHouseholdOperationScope).toHaveBeenCalledTimes(2);
    });
    expect(executeScript).not.toHaveBeenCalled();
  });
});
