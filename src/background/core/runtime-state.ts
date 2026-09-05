import { createSyncRunRegistry, SyncRunCancelledError } from "../../lib/sync-run";
import type {
  LoginState,
  ProviderId,
  ProviderSyncState,
} from "../../lib/types";
import { getHouseholdProviderStorageKey } from "../../lib/household-context";
import type { HouseholdSyncTarget } from "../../lib/household-context";

export interface RuntimeState extends ProviderSyncState {
  loginState: LoginState;
  tabId: number | null;
  syncTarget: HouseholdSyncTarget | null;
}

function defaultState(): RuntimeState {
  return {
    status: "idle",
    loginState: "unknown",
    data: null,
    error: null,
    lastSyncedAt: null,
    progressMessage: null,
    backendSyncStatus: null,
    backendSyncError: null,
    pendingBackendPush: false,
    lastBackendPushAttemptAt: null,
    tabId: null,
    syncTarget: null,
  };
}

function getRunKey(providerId: ProviderId, attemptId: string) {
  return `${providerId}:${attemptId}`;
}

export function createRuntimeStateStore() {
  let householdScope: {
    accountScopeId: string;
    memberId: string;
    memberLifecycleVersion: number;
    isPrimary: boolean;
  } | null = null;
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

  function getProviderStorageKey(providerId: ProviderId) {
    return householdScope
      ? getHouseholdProviderStorageKey(
          householdScope.accountScopeId,
          householdScope.memberId,
          householdScope.memberLifecycleVersion,
          providerId,
        )
      : `provider_${providerId}`;
  }

  function getPersistedSyncTarget(
    value: unknown,
    providerId: ProviderId,
  ): HouseholdSyncTarget | null {
    if (!value || typeof value !== "object") return null;
    const target = Object.fromEntries(Object.entries(value));
    if (
      target.provider !== providerId
      || typeof target.accountScopeId !== "string"
      || typeof target.memberId !== "string"
      || typeof target.memberDisplayName !== "string"
      || typeof target.memberLifecycleVersion !== "number"
      || typeof target.contextRevision !== "string"
      || typeof target.operationId !== "string"
    ) {
      return null;
    }
    return {
      provider: providerId,
      accountScopeId: target.accountScopeId,
      memberId: target.memberId,
      memberDisplayName: target.memberDisplayName,
      memberLifecycleVersion: target.memberLifecycleVersion,
      contextRevision: target.contextRevision,
      operationId: target.operationId,
    };
  }

  async function hydratePersistedState() {
    resetAllStates();
    await Promise.all(
      (Object.keys(states) as ProviderId[]).map(async (providerId) => {
        const storageKey = getProviderStorageKey(providerId);
        const keys = householdScope?.isPrimary
          ? [storageKey, `provider_${providerId}`]
          : [storageKey];
        const result = await chrome.storage.local.get(keys);
        const namespacedState = result[storageKey];
        const legacyState = householdScope?.isPrimary
          ? result[`provider_${providerId}`]
          : null;
        const savedState = namespacedState ?? legacyState;
        const syncTarget = getPersistedSyncTarget(
          savedState?.syncTarget,
          providerId,
        );
        if (
          !savedState?.lastSyncedAt
          && !savedState?.pendingBackendPush
          && !syncTarget
        ) return;

        if (!namespacedState && legacyState && householdScope?.isPrimary) {
          await chrome.storage.local.set({ [storageKey]: legacyState });
        }

        states[providerId].lastSyncedAt = savedState.lastSyncedAt;
        states[providerId].data = savedState.data ?? null;
        states[providerId].backendSyncStatus = savedState.backendSyncStatus ?? null;
        states[providerId].backendSyncError = savedState.backendSyncError ?? null;
        states[providerId].pendingBackendPush = Boolean(savedState.pendingBackendPush);
        states[providerId].lastBackendPushAttemptAt =
          typeof savedState.lastBackendPushAttemptAt === "string"
            ? savedState.lastBackendPushAttemptAt
            : null;
        states[providerId].syncTarget = syncTarget;
        states[providerId].status = savedState.status === "awaiting_confirmation"
          ? "awaiting_confirmation"
          : savedState.pendingBackendPush
            ? savedState.status === "done"
              ? "done"
              : "error"
            : savedState.lastSyncedAt
              ? "done"
              : "idle";
        states[providerId].error = savedState.pendingBackendPush
          ? savedState.backendSyncError ?? savedState.error ?? null
          : savedState.error ?? null;
      })
    );
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
    const {
      status,
      data,
      error,
      lastSyncedAt,
      backendSyncStatus,
      backendSyncError,
      pendingBackendPush,
      lastBackendPushAttemptAt,
      syncTarget,
    } = states[providerId];
    return chrome.storage.local.set({
      [getProviderStorageKey(providerId)]: {
        status,
        data,
        error,
        lastSyncedAt,
        backendSyncStatus,
        backendSyncError,
        pendingBackendPush,
        lastBackendPushAttemptAt,
        syncTarget,
      },
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
    const {
      status,
      data,
      error,
      lastSyncedAt,
      progressMessage,
      backendSyncStatus,
      backendSyncError,
      pendingBackendPush,
      lastBackendPushAttemptAt,
    } = states[providerId];
    return {
      status,
      data,
      error,
      lastSyncedAt,
      progressMessage,
      backendSyncStatus,
      backendSyncError,
      pendingBackendPush,
      lastBackendPushAttemptAt,
    };
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
    if (runRegistry.getRun(providerId)?.attemptId !== attemptId) return;
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

  async function setHouseholdScope(scope: {
    accountScopeId: string;
    memberId: string;
    memberLifecycleVersion: number;
    isPrimary: boolean;
  } | null) {
    if (
      householdScope?.accountScopeId === scope?.accountScopeId
      && householdScope?.memberId === scope?.memberId
      && householdScope?.memberLifecycleVersion === scope?.memberLifecycleVersion
      && householdScope?.isPrimary === scope?.isPrimary
    ) {
      return;
    }
    householdScope = scope;
    await hydratePersistedState();
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
    setHouseholdScope,
  };
}
