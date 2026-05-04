import { createSyncRunRegistry, SyncRunCancelledError } from "../../lib/sync-run";
import type {
  LoginState,
  ProviderId,
  ProviderSyncState,
} from "../../lib/types";

export interface RuntimeState extends ProviderSyncState {
  loginState: LoginState;
  tabId: number | null;
}

function defaultState(): RuntimeState {
  return {
    status: "idle",
    loginState: "unknown",
    data: null,
    error: null,
    lastSyncedAt: null,
    progressMessage: null,
    tabId: null,
  };
}

function getRunKey(providerId: ProviderId, attemptId: string) {
  return `${providerId}:${attemptId}`;
}

export function createRuntimeStateStore() {
  const states: Record<ProviderId, RuntimeState> = {
    marriott: defaultState(),
    atmos: defaultState(),
    chase: defaultState(),
    aa: defaultState(),
    delta: defaultState(),
    united: defaultState(),
    southwest: defaultState(),
    ihg: defaultState(),
    hyatt: defaultState(),
    amex: defaultState(),
    capitalone: defaultState(),
    hilton: defaultState(),
    frontier: defaultState(),
    bilt: defaultState(),
    discover: defaultState(),
    citi: defaultState(),
  };

  const runRegistry = createSyncRunRegistry();
  const runCancelListeners = new Map<string, Set<() => void>>();

  function hydratePersistedState() {
    for (const providerId of Object.keys(states) as ProviderId[]) {
      chrome.storage.local.get(`provider_${providerId}`, (result) => {
        const savedState = result[`provider_${providerId}`];
        if (!savedState?.lastSyncedAt) return;

        states[providerId].lastSyncedAt = savedState.lastSyncedAt;
        states[providerId].data = savedState.data ?? null;
        states[providerId].status = "done";
      });
    }
  }

  function isProviderId(value: unknown): value is ProviderId {
    return typeof value === "string" && value in states;
  }

  function updateProvider(providerId: ProviderId, updates: Partial<RuntimeState>) {
    Object.assign(states[providerId], updates);
    if (
      updates.status
      && updates.status !== "detecting_login"
      && updates.status !== "waiting_for_login"
      && updates.status !== "extracting"
      && !("progressMessage" in updates)
    ) {
      states[providerId].progressMessage = null;
    }
    const { status, data, error, lastSyncedAt } = states[providerId];
    chrome.storage.local.set({
      [`provider_${providerId}`]: { status, data, error, lastSyncedAt },
    });
  }

  async function waitForSyncStart(providerId: ProviderId, timeoutMs = 4000) {
    const startedImmediately =
      states[providerId].tabId != null || states[providerId].status === "error";
    if (startedImmediately) {
      return states[providerId].tabId != null;
    }

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (states[providerId].tabId != null) {
        return true;
      }
      if (states[providerId].status === "error") {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return states[providerId].tabId != null;
  }

  function getPublicState(providerId: ProviderId) {
    const { status, data, error, lastSyncedAt, progressMessage } = states[providerId];
    return { status, data, error, lastSyncedAt, progressMessage };
  }

  function getAllPublicStates() {
    return {
      marriott: getPublicState("marriott"),
      atmos: getPublicState("atmos"),
      chase: getPublicState("chase"),
      aa: getPublicState("aa"),
      delta: getPublicState("delta"),
      united: getPublicState("united"),
      southwest: getPublicState("southwest"),
      ihg: getPublicState("ihg"),
      hyatt: getPublicState("hyatt"),
      amex: getPublicState("amex"),
      capitalone: getPublicState("capitalone"),
      hilton: getPublicState("hilton"),
      frontier: getPublicState("frontier"),
      bilt: getPublicState("bilt"),
      discover: getPublicState("discover"),
      citi: getPublicState("citi"),
    };
  }

  function setLoginState(providerId: ProviderId, loginState: LoginState) {
    states[providerId].loginState = loginState;
  }

  function setTabId(providerId: ProviderId, tabId: number | null) {
    states[providerId].tabId = tabId;
  }

  function beginSyncRun(providerId: ProviderId) {
    return runRegistry.beginRun(providerId);
  }

  function finishSyncRun(providerId: ProviderId, attemptId: string) {
    states[providerId].tabId = null;
    states[providerId].progressMessage = null;
    runRegistry.clearRun(providerId, attemptId);
  }

  function assertRunActive(providerId: ProviderId, attemptId: string) {
    runRegistry.assertRunActive(providerId, attemptId);
  }

  function isRunActive(providerId: ProviderId, attemptId: string) {
    return runRegistry.isActive(providerId, attemptId);
  }

  function wasRunCancelled(providerId: ProviderId, attemptId: string, error: unknown) {
    if (error instanceof SyncRunCancelledError) {
      return true;
    }

    return !isRunActive(providerId, attemptId);
  }

  function recordRunTab(
    providerId: ProviderId,
    attemptId: string,
    tabId: number,
    options: { owned: boolean },
  ) {
    runRegistry.recordObservedTab(providerId, attemptId, tabId, options);
    states[providerId].tabId = tabId;
  }

  function createRunCancelSignal(providerId: ProviderId, attemptId: string) {
    const key = getRunKey(providerId, attemptId);
    let cleanup = () => {};

    const promise = new Promise<never>((_resolve, reject) => {
      const listeners = runCancelListeners.get(key) ?? new Set<() => void>();
      const onCancel = () => {
        cleanup();
        reject(new SyncRunCancelledError(providerId, attemptId));
      };

      listeners.add(onCancel);
      runCancelListeners.set(key, listeners);

      cleanup = () => {
        const currentListeners = runCancelListeners.get(key);
        if (!currentListeners) return;
        currentListeners.delete(onCancel);
        if (currentListeners.size === 0) {
          runCancelListeners.delete(key);
        }
      };
    });

    return {
      promise,
      cancel: () => cleanup(),
    };
  }

  function notifyRunCancelled(providerId: ProviderId, attemptId: string) {
    const listeners = runCancelListeners.get(getRunKey(providerId, attemptId));
    if (!listeners) return;
    for (const listener of listeners) {
      listener();
    }
  }

  function getRun(providerId: ProviderId) {
    return runRegistry.getRun(providerId);
  }

  function markRunCancelled(providerId: ProviderId) {
    return runRegistry.markCancelled(providerId);
  }

  function resetAllStates() {
    for (const providerId of Object.keys(states) as ProviderId[]) {
      states[providerId] = defaultState();
    }
  }

  return {
    states,
    hydratePersistedState,
    isProviderId,
    updateProvider,
    waitForSyncStart,
    getPublicState,
    getAllPublicStates,
    setLoginState,
    setTabId,
    beginSyncRun,
    finishSyncRun,
    assertRunActive,
    isRunActive,
    wasRunCancelled,
    recordRunTab,
    createRunCancelSignal,
    notifyRunCancelled,
    getRun,
    markRunCancelled,
    resetAllStates,
  };
}
