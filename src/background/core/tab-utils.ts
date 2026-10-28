import type { ProviderDefinition } from "../../providers/provider-registry";
import type { LoginState, ProviderId } from "../../lib/types";
import type { createRuntimeStateStore } from "./runtime-state";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

export function urlMatchesPattern(url: string, pattern: string) {
  const regex = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}`,
  );
  return regex.test(url);
}

export function isUrlAllowedForProvider(url: string, definition: ProviderDefinition) {
  if (urlMatchesPattern(url, definition.tabUrlPattern)) return true;
  for (const pattern of definition.allowedUrlPatterns ?? []) {
    if (urlMatchesPattern(url, pattern)) return true;
  }
  for (const pattern of definition.extraHostPermissions ?? []) {
    if (urlMatchesPattern(url, pattern)) return true;
  }
  return false;
}

function sameSyncPage(value: string, target: string) {
  try {
    const page = new URL(value);
    const expected = new URL(target);
    for (const url of [page, expected]) {
      for (const key of [...url.searchParams.keys()]) {
        if (key === "lid" || key.startsWith("utm_")) url.searchParams.delete(key);
      }
    }
    return page.origin === expected.origin
      && page.pathname.replace(/\/+$/, "") === expected.pathname.replace(/\/+$/, "")
      && page.search === expected.search
      && page.hash === expected.hash;
  } catch {
    return false;
  }
}

/** Borrow only known sync entry pages. Same-provider booking/payment pages are not candidates. */
export function createProviderSyncTabOpener(options: {
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  getReservedTabIds: () => Promise<readonly number[]>;
}) {
  function isReserved(tabId: number, reserved: readonly number[]) {
    return reserved.includes(tabId) || Object.values(options.providerRegistry).some(definition => {
      const run = options.stateStore.getRun(definition.id);
      return run && !run.cancelled && run.observedTabIds.has(tabId);
    });
  }
  return async (providerId: ProviderId, attemptId: string) => {
    const waitUntilLoaded = async (tabId: number) => {
      const cancellation = options.stateStore.createRunCancelSignal(providerId, attemptId);
      const controller = new AbortController();
      void cancellation.promise.catch(() => controller.abort());
      try {
        await waitForTabLoad(tabId, 30000, controller.signal);
      } finally {
        cancellation.cancel();
      }
    };
    const definition = options.providerRegistry[providerId];
    const startUrl = (definition.syncStrategy === "hyatt" || definition.syncStrategy === "bilt")
      ? definition.accountUrl ?? definition.syncUrl
      : definition.syncUrl;
    const accountUrl = definition.accountUrl ?? definition.syncUrl;
    const eligible = (tab: chrome.tabs.Tab) => tab.id !== undefined && !!tab.url
      && [definition.syncUrl, accountUrl].some(url => sameSyncPage(tab.url ?? "", url))
      && (!tab.pendingUrl || [definition.syncUrl, accountUrl].some(url => sameSyncPage(tab.pendingUrl ?? "", url)));
    options.stateStore.assertRunActive(providerId, attemptId);
    const [tabs, reserved] = await Promise.all([
      chrome.tabs.query({ currentWindow: true }), options.getReservedTabIds()
    ]);
    options.stateStore.assertRunActive(providerId, attemptId);
    const candidates = tabs.filter(tab => eligible(tab) && tab.id !== undefined && !isReserved(tab.id, reserved));
    const selected = candidates.find(tab => tab.active) ?? (candidates.length === 1 ? candidates[0] : undefined);
    const current = selected?.id !== undefined ? await chrome.tabs.get(selected.id).catch(() => null) : null;
    options.stateStore.assertRunActive(providerId, attemptId);
    if (current?.id !== undefined && eligible(current) && !isReserved(current.id, reserved)) {
      const tabId = current.id;
      options.stateStore.recordRunTab(providerId, attemptId, tabId, { owned: false });
      const activated = await chrome.tabs.update(tabId, { active: true });
      options.stateStore.assertRunActive(providerId, attemptId);
      if (!eligible(activated)) throw new Error("The account tab changed before sync started. Try again.");
      if (activated.status !== "complete" || activated.discarded || activated.pendingUrl) await waitUntilLoaded(tabId);
      options.stateStore.assertRunActive(providerId, attemptId);
      return tabId;
    }
    const tab = await chrome.tabs.create({ url: startUrl, active: true });
    if (tab.id === undefined) throw new Error("Could not create sync tab");
    if (!options.stateStore.isRunActive(providerId, attemptId)) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      options.stateStore.assertRunActive(providerId, attemptId);
    }
    options.stateStore.recordRunTab(providerId, attemptId, tab.id, { owned: true });
    if (tab.status !== "complete") await waitUntilLoaded(tab.id);
    options.stateStore.assertRunActive(providerId, attemptId);
    return tab.id;
  };
}

export type ProviderSyncTabOpener = ReturnType<typeof createProviderSyncTabOpener>;

/** Cancellation owns the run, not every tab the run happened to read. */
export function createSyncRunCanceller(stateStore: RuntimeStateStore) {
  return async (providerId: ProviderId, error: string | null = null) => {
    const run = stateStore.markRunCancelled(providerId);
    stateStore.updateProvider(providerId, { status: "cancelled", error });
    stateStore.setTabId(providerId, null);
    if (!run) return;
    stateStore.notifyRunCancelled(providerId, run.attemptId);
    for (const tabId of run.observedTabIds) {
      void sendToTab(tabId, { type: "ABORT_SYNC_RUN", provider: providerId, attemptId: run.attemptId }).catch(() => {});
    }
    if (run.ownedTabId !== null) {
      await chrome.tabs.remove(run.ownedTabId).catch(() => {});
    }
    stateStore.finishSyncRun(providerId, run.attemptId);
  };
}

export function createExtensionNavigationState() {
  return new Set<number>();
}

export function registerNavigationGuard(options: {
  extensionNavigatingTabs: Set<number>;
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  cancelRun: (providerId: ProviderId, error?: string | null) => Promise<void>;
}) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.url && changeInfo.status !== "complete") return;
    if (options.extensionNavigatingTabs.has(tabId)) return;

    const url = changeInfo.url ?? tab.url ?? "";
    if (!url || url.startsWith("about:") || url.startsWith("chrome")) return;

    for (const providerId of Object.keys(options.providerRegistry) as ProviderId[]) {
      const run = options.stateStore.getRun(providerId);
      if (!run || run.cancelled) continue;
      if (run.ownedTabId !== tabId && !run.observedTabIds.has(tabId)) continue;

      const definition = options.providerRegistry[providerId];
      if (!isUrlAllowedForProvider(url, definition)) {
        void options.cancelRun(
          providerId,
          `Sync cancelled — you navigated away from ${definition.name}`,
        );
      }
    }
  });
}

export function waitForTabLoad(tabId: number, timeoutMs = 30000, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for tab to load"));
    }, timeoutMs);

    let completed = false;
    function onUpdated(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (!completed && updatedTabId === tabId && changeInfo.status === "complete") {
        completed = true;
        cleanup();
        setTimeout(resolve, 500);
      }
    }

    function onRemoved(removedTabId: number) {
      if (!completed && removedTabId === tabId) {
        completed = true;
        cleanup();
        reject(new Error("Tab was closed"));
      }
    }

    function onAbort() {
      if (completed) return;
      completed = true;
      cleanup();
      reject(new Error("Sync cancelled while loading the tab"));
    }

    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete" && !tab.discarded && !tab.pendingUrl) onUpdated(tabId, { status: "complete" });
    }).catch(() => onRemoved(tabId));
  });
}

export function navigateAndWait(
  tabId: number,
  url: string,
  extensionNavigatingTabs: Set<number>,
) {
  extensionNavigatingTabs.add(tabId);
  chrome.tabs.update(tabId, { url });
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out loading ${url}`));
    }, 30000);

    function onUpdated(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        setTimeout(resolve, 3000);
      }
    }

    function onRemoved(removedTabId: number) {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error("Tab was closed"));
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      extensionNavigatingTabs.delete(tabId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

export function tabClosedSignal(tabId: number) {
  let onRemoved: ((removedTabId: number) => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) {
        chrome.tabs.onRemoved.removeListener(onRemoved!);
        reject(new Error("Tab was closed"));
      }
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
  });

  return {
    promise,
    cancel: () => {
      if (onRemoved) chrome.tabs.onRemoved.removeListener(onRemoved);
    },
  };
}

export function sendToTab(tabId: number, message: Record<string, unknown>) {
  return new Promise<unknown>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

export function sendRunMessageToTab(
  tabId: number,
  providerId: ProviderId,
  attemptId: string,
  message: Record<string, unknown>,
  assertRunActive: (providerId: ProviderId, attemptId: string) => void,
) {
  assertRunActive(providerId, attemptId);
  return sendToTab(tabId, { ...message, provider: providerId, attemptId });
}

export async function triggerExtraction(options: {
  providerId: ProviderId;
  attemptId: string;
  tabId: number;
  assertRunActive: (providerId: ProviderId, attemptId: string) => void;
  message?: Record<string, unknown>;
  retries?: number;
  retryDelayMs?: number;
}) {
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const message = options.message ?? { type: "START_EXTRACTION" };

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      options.assertRunActive(options.providerId, options.attemptId);
      await sendRunMessageToTab(
        options.tabId,
        options.providerId,
        options.attemptId,
        message,
        options.assertRunActive,
      );
      return;
    } catch {
      if (attempt === retries - 1) {
        throw new Error("Content script not reachable");
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

export async function getTabLoginState(tabId: number): Promise<LoginState> {
  const response = await sendToTab(tabId, { type: "GET_LOGIN_STATE" });
  if (
    response
    && typeof response === "object"
    && "state" in response
    && (response.state === "logged_in"
      || response.state === "logged_out"
      || response.state === "mfa_challenge"
      || response.state === "unknown")
  ) {
    return response.state;
  }
  return "unknown";
}

export async function checkIfLoginPage(tabId: number) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return false;
  const url = tab.url.toLowerCase();
  return (
    url.includes("/login")
    || url.includes("/signin")
    || url.includes("sign-in")
    || url.includes("auth0")
    || url.includes("identity-management")
    || url.includes("otp-challenge")
    || url.includes("confirmidentity")
  );
}

export async function recoverFromStall(options: {
  providerId: ProviderId;
  attemptId: string;
  tabId: number;
  isFirstPhase: boolean;
  assertRunActive: (providerId: ProviderId, attemptId: string) => void;
  triggerExtraction: () => Promise<void>;
}) {
  options.assertRunActive(options.providerId, options.attemptId);
  if (await checkIfLoginPage(options.tabId)) return "login_needed" as const;

  const tab = await chrome.tabs.get(options.tabId).catch(() => null);
  if (!tab) {
    throw new Error(`${options.providerId}: tab closed during sync`);
  }

  if (options.isFirstPhase) {
    await chrome.tabs.reload(options.tabId);
    await waitForTabLoad(options.tabId, 30000);
  }

  await options.triggerExtraction();
  return "retried" as const;
}
