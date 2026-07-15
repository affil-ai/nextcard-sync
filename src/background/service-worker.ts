import type { NextCardAuth, ProviderId, PushToNextCardResult } from "../lib/types";
import { clearAuth, getAuth, setAuth, startSignIn, verifyAuth } from "../lib/auth";
import {
  fetchExtensionProfile,
  getBestAvailableExtensionProfile,
  getStoredExtensionProfile,
  getUpgradeUrl,
  isProviderLocked,
  selectExtensionSyncProvider,
  setStoredExtensionProfile,
} from "../lib/extension-profile";
import {
  deleteFromNextCard,
  pullFromNextCard,
  pushToNextCard,
  validateProviderData,
} from "../lib/sync-to-nextcard";
import { syncOffersToNextCard, syncDetectedOffersToNextCard, retryPendingOfferSyncs, pullOfferUrlCache } from "../lib/sync-offers-to-nextcard";
import type { OfferSyncPayload, DetectedOfferSyncPayload } from "../lib/sync-offers-to-nextcard";
import { providerRegistry } from "../providers/provider-registry";
import { createMessageRouter, createExternalMessageRouter } from "./core/message-router";
import { createRuntimeStateStore } from "./core/runtime-state";
import {
  createExtensionNavigationState,
  registerNavigationGuard,
  sendToTab,
} from "./core/tab-utils";
import { createAmexSync } from "./syncs/amex";
import { createBiltSync } from "./syncs/bilt";
import { createCapitalOneSync } from "./syncs/capitalone";
import { createChaseSync } from "./syncs/chase";
import { createGenericSyncHandlers } from "./syncs/generic";
import { createHyattSync } from "./syncs/hyatt";
import { registerMerchantOfferAlertMonitor } from "./merchant-offer-alerts";

const VERIFY_INTERVAL_MS = 5 * 60 * 1000;
const BACKEND_PUSH_RETRY_COOLDOWN_MS = 30 * 1000;
type EnrolledOfferSyncMessage = Omit<OfferSyncPayload["offers"][number], "enrolledAt">;

let lastVerifyAt = 0;
let lastVerifyResult: NextCardAuth | null = null;
let pendingProviderRetryPromise: Promise<void> | null = null;
const providersRetriedThisSession = new Set<ProviderId>();

const stateStore = createRuntimeStateStore();
const extensionNavigatingTabs = createExtensionNavigationState();

const persistedStateHydrated = stateStore.hydratePersistedState();

async function getCachedAuth() {
  const now = Date.now();
  if (now - lastVerifyAt < VERIFY_INTERVAL_MS) {
    return lastVerifyResult;
  }

  const valid = await verifyAuth();
  lastVerifyAt = now;
  if (!valid) {
    lastVerifyResult = null;
    return null;
  }

  lastVerifyResult = await getAuth();
  return lastVerifyResult;
}

function resetAuthCache() {
  lastVerifyAt = 0;
  lastVerifyResult = null;
}

function isProviderAttemptMessage(
  message: Record<string, unknown>,
  providerId: ProviderId,
  attemptId: string,
  type?: string,
) {
  if (message.provider !== providerId) {
    return false;
  }
  if (message.attemptId !== attemptId) {
    return false;
  }
  if (type && message.type !== type) {
    return false;
  }
  return true;
}

async function cancelRun(providerId: ProviderId, error: string | null = null) {
  const run = stateStore.markRunCancelled(providerId);
  stateStore.updateProvider(providerId, { status: "cancelled", error });
  stateStore.setTabId(providerId, null);

  if (!run) {
    return;
  }

  stateStore.notifyRunCancelled(providerId, run.attemptId);

  for (const tabId of run.observedTabIds) {
    void sendToTab(tabId, {
      type: "ABORT_SYNC_RUN",
      provider: providerId,
      attemptId: run.attemptId,
    }).catch(() => {
      // Tabs can disappear during cancel, so best-effort cleanup is enough here.
    });
  }

  if (run.ownedTabId != null) {
    await chrome.tabs.remove(run.ownedTabId).catch(() => {
      // Users can close the sync tab themselves before the worker gets here.
    });
  }

  stateStore.finishSyncRun(providerId, run.attemptId);
}

async function hydrateFromNextCard() {
  const result = await pullFromNextCard();
  if (!result.ok || !Array.isArray(result.accounts) || result.accounts.length === 0) {
    return;
  }

  // Existing server data means the user has already completed the extension onboarding.
  await chrome.storage.local.set({
    disclosureAccepted: true,
    consentGiven: true,
    firstSyncCompleted: true,
  });

  let hydratedCount = 0;
  for (const account of result.accounts) {
    if (
      typeof account.provider !== "string"
      || !stateStore.isProviderId(account.provider)
    ) {
      continue;
    }

    const providerId = account.provider;
    const currentState = stateStore.states[providerId];
    if (currentState.pendingBackendPush && currentState.data) {
      continue;
    }
    if (currentState.status === "done" && currentState.lastSyncedAt) {
      const localTime = new Date(currentState.lastSyncedAt).getTime();
      const serverTime = new Date(account.lastSyncedAt).getTime();
      if (localTime >= serverTime) {
        continue;
      }
    }

    stateStore.updateProvider(providerId, {
      status: "done",
      data: account.providerData ?? null,
      error: null,
      lastSyncedAt: account.lastSyncedAt,
    });
    hydratedCount += 1;
  }

  if (hydratedCount > 0) {
  }
}

async function refreshExtensionProfile() {
  try {
    const profile = await fetchExtensionProfile();
    if (profile?.accountLevel === "pro") {
      void retryPendingProviderPushes({ includeBlocked: true });
    }
    return profile;
  } catch (error) {
    console.warn("[NextCard SW] Extension profile refresh failed:", error);
    const storedProfile = await getStoredExtensionProfile();
    if (storedProfile?.accountLevel === "pro") {
      void retryPendingProviderPushes({ includeBlocked: true });
    }
    return storedProfile;
  }
}

function formatProgramNames(programs: PushToNextCardResult["skippedRewardsPrograms"]) {
  if (!programs?.length) return "some rewards programs";
  const names = programs.map((program) => program.name).filter(Boolean);
  if (names.length === 0) return "some rewards programs";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function getBackendSyncError(result: PushToNextCardResult) {
  const skippedNames = formatProgramNames(result.skippedRewardsPrograms);
  if (!result.ok && result.error === "selection_locked") {
    return `${skippedNames} were captured but not saved to nextcard because your current plan limits synced rewards programs. Upgrade to Pro or retry after upgrading.`;
  }
  if (!result.ok) {
    return result.error ?? "Could not save this sync to nextcard.";
  }
  return `${skippedNames} were captured but not saved to nextcard because your current plan limits synced rewards programs. Upgrade to Pro or retry after upgrading.`;
}

function updateProviderFromBackendPush(
  providerId: ProviderId,
  result: PushToNextCardResult,
) {
  const skippedCount = result.skippedRewardsPrograms?.length ?? 0;
  const syncedCount = result.syncedRewardsPrograms?.length ?? 0;
  const attemptedAt = new Date().toISOString();

  if (result.ok && skippedCount === 0) {
    stateStore.updateProvider(providerId, {
      status: "done",
      error: null,
      backendSyncStatus: "saved",
      backendSyncError: null,
      pendingBackendPush: false,
      lastBackendPushAttemptAt: attemptedAt,
      lastSyncedAt: new Date().toISOString(),
    });
    providersRetriedThisSession.delete(providerId);
    return;
  }

  if (result.isLimited === true && skippedCount === 0) {
    result = {
      ...result,
      skippedRewardsPrograms: [
        {
          id: "unknown",
          slug: "unknown",
          name: "Some rewards programs",
        },
      ],
    };
  }

  const backendSyncError = getBackendSyncError(result);
  if (result.ok && skippedCount > 0 && syncedCount > 0) {
    stateStore.updateProvider(providerId, {
      status: "done",
      error: backendSyncError,
      backendSyncStatus: "partial",
      backendSyncError,
      pendingBackendPush: true,
      lastBackendPushAttemptAt: attemptedAt,
    });
    return;
  }

  const backendSyncStatus =
    result.error === "selection_locked" || skippedCount > 0 ? "blocked" : "failed";
  stateStore.updateProvider(providerId, {
    status: "error",
    error: backendSyncError,
    lastSyncedAt: null,
    backendSyncStatus,
    backendSyncError,
    pendingBackendPush: true,
    lastBackendPushAttemptAt: attemptedAt,
  });
}

async function recordConsent(message: Record<string, unknown>) {
  const auth = await getCachedAuth();
  if (!auth?.token) {
    console.warn(
      "[NextCard SW] Consent: no auth token available, skipping API call",
    );
    return;
  }

  try {
    await fetch(`${__CONVEX_SITE_URL__}/extension/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        consentType: message.consentType,
        extensionVersion: message.extensionVersion,
        userAgent: message.userAgent,
      }),
    });
  } catch {
    console.warn("[NextCard SW] Consent API call failed");
  }
}

function onSignOut() {
  resetAuthCache();
  stateStore.resetAllStates();
  void setStoredExtensionProfile(null);
}

async function pushScrapedData(providerId: ProviderId, data: unknown) {
  const validated = validateProviderData(providerId, data);
  if (!validated.ok) {
    const attemptedAt = new Date().toISOString();
    stateStore.updateProvider(providerId, {
      status: "error",
      error: validated.error,
      backendSyncStatus: "failed",
      backendSyncError: validated.error,
      pendingBackendPush: false,
      lastBackendPushAttemptAt: attemptedAt,
    });
    return { ok: false, error: validated.error };
  }

  const result = await pushToNextCard(providerId, validated.data);
  updateProviderFromBackendPush(providerId, result);
  if (!result.ok && result.error === "selection_locked") {
    await refreshExtensionProfile();
  }
  return result;
}

async function retryPendingProviderPushes(
  options: { includeBlocked?: boolean } = {},
) {
  if (pendingProviderRetryPromise) {
    return pendingProviderRetryPromise;
  }

  pendingProviderRetryPromise = (async () => {
    const now = Date.now();
    for (const providerId of Object.keys(stateStore.states) as ProviderId[]) {
      const state = stateStore.states[providerId];
      if (!state.pendingBackendPush || !state.data) continue;
      if (stateStore.getRun(providerId)) continue;
      if (providersRetriedThisSession.has(providerId)) continue;
      if (state.backendSyncStatus === "blocked" && !options.includeBlocked) continue;

      const lastAttemptMs = state.lastBackendPushAttemptAt
        ? Date.parse(state.lastBackendPushAttemptAt)
        : 0;
      if (
        Number.isFinite(lastAttemptMs) &&
        lastAttemptMs > 0 &&
        now - lastAttemptMs < BACKEND_PUSH_RETRY_COOLDOWN_MS
      ) {
        continue;
      }

      providersRetriedThisSession.add(providerId);
      await pushScrapedData(providerId, state.data);
      if (stateStore.states[providerId].pendingBackendPush) {
        providersRetriedThisSession.delete(providerId);
      }
    }
  })().finally(() => {
    pendingProviderRetryPromise = null;
  });

  return pendingProviderRetryPromise;
}

let upgradeTabPromise: Promise<void> | null = null;

function samePageUrl(left: string, right: string) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.origin === rightUrl.origin
      && leftUrl.pathname === rightUrl.pathname
      && leftUrl.search === rightUrl.search
    );
  } catch {
    return false;
  }
}

async function openUpgradeTab() {
  if (upgradeTabPromise) {
    return upgradeTabPromise;
  }

  upgradeTabPromise = (async () => {
    const profile = await getStoredExtensionProfile();
    const upgradeUrl = getUpgradeUrl(profile);
    const existingTab = (await chrome.tabs.query({})).find((tab) =>
      tab.url ? samePageUrl(tab.url, upgradeUrl) : false
    );

    if (existingTab?.id != null) {
      if (existingTab.windowId != null) {
        await chrome.windows.update(existingTab.windowId, { focused: true });
      }
      await chrome.tabs.update(existingTab.id, { active: true, url: upgradeUrl });
      return;
    }

    await chrome.tabs.create({ url: upgradeUrl, active: true });
  })();

  try {
    await upgradeTabPromise;
  } finally {
    upgradeTabPromise = null;
  }
}

const genericHandlers = createGenericSyncHandlers({
  providerRegistry,
  stateStore,
  extensionNavigatingTabs,
  isProviderAttemptMessage,
  pushToNextCard: pushScrapedData,
});

const syncHandlers = {
  generic: genericHandlers.startSync,
  atmos: genericHandlers.startAtmosSync,
  "chase-v1": createChaseSync({
    providerRegistry,
    stateStore,
    extensionNavigatingTabs,
    isProviderAttemptMessage,
    pushToNextCard: pushScrapedData,
    refreshOfferUrlCache: pullOfferUrlCache,
  }),
  amex: createAmexSync({
    providerRegistry,
    stateStore,
    waitForGenericLoginAndExtract: genericHandlers.waitForGenericLoginAndExtract,
    isProviderAttemptMessage,
    pushToNextCard: pushScrapedData,
  }),
  capitalone: createCapitalOneSync({
    providerRegistry,
    stateStore,
    extensionNavigatingTabs,
    waitForGenericLoginAndExtract: genericHandlers.waitForGenericLoginAndExtract,
    isProviderAttemptMessage,
    pushToNextCard: pushScrapedData,
  }),
  hyatt: createHyattSync({
    providerRegistry,
    stateStore,
    extensionNavigatingTabs,
    waitForGenericLoginAndExtract: genericHandlers.waitForGenericLoginAndExtract,
    isProviderAttemptMessage,
    pushToNextCard: pushScrapedData,
  }),
  bilt: createBiltSync({
    providerRegistry,
    stateStore,
    extensionNavigatingTabs,
    waitForGenericLoginAndExtract: genericHandlers.waitForGenericLoginAndExtract,
    isProviderAttemptMessage,
    pushToNextCard: pushScrapedData,
  }),
};

chrome.action.onClicked.addListener((tab) => {
  if (tab.windowId) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

registerNavigationGuard({
  extensionNavigatingTabs,
  providerRegistry,
  stateStore,
  cancelRun,
});
registerMerchantOfferAlertMonitor();

chrome.runtime.onMessage.addListener(
  createMessageRouter({
    providerRegistry,
    stateStore,
    syncHandlers,
    cancelRun,
    startSignIn,
    clearAuth,
    getCachedAuth,
    onSignOut,
    recordConsent,
    pushToNextCard: pushScrapedData,
    deleteFromNextCard,
    isProviderLocked: async (providerId) => {
      const profile = await getBestAvailableExtensionProfile();
      if (isProviderLocked(profile, providerId)) {
        return true;
      }

      if (profile?.accountLevel === "pro") {
        return false;
      }

      try {
        const selection = await selectExtensionSyncProvider(providerId);
        return !selection.ok;
      } catch (error) {
        console.warn("[NextCard SW] Extension provider selection failed:", error);
        return true;
      }
    },
    getExtensionProfile: getStoredExtensionProfile,
    refreshExtensionProfile,
    openUpgrade: openUpgradeTab,
    syncEnrolledOffers: async (issuer, message) => {
      // Reuse the sync payload shape so message handlers stay aligned with backend expectations.
      const enrolledOffers = message.enrolledOffers as EnrolledOfferSyncMessage[];

      const payload: OfferSyncPayload = {
        issuer,
        issuerCardId: String(message.cardId ?? message.accountId ?? ""),
        issuerCardName: String(message.cardName ?? ""),
        issuerCardLastDigits: (message.cardLastDigits as string) ?? null,
        offers: enrolledOffers.map((o) => ({
          ...o,
          enrolledAt: new Date().toISOString(),
        })),
      };

      // The router waits for this promise so every verified card has either
      // reached NextCard or been persisted for the existing retry path before
      // the Amex run is reported complete.
      const syncedOrQueued = await syncOffersToNextCard(payload);
      if (!syncedOrQueued) {
        throw new Error("Could not persist the verified Amex offer sync for retry");
      }
    },
    syncDetectedOffers: (issuer, message) => {
      type DetectedOfferMsg = Omit<DetectedOfferSyncPayload["offers"][number], "detectedAt">;
      const detectedOffers = message.detectedOffers as DetectedOfferMsg[];
      const observedIssuerOfferIds = Array.isArray(message.observedIssuerOfferIds)
        ? message.observedIssuerOfferIds.filter(
            (issuerOfferId): issuerOfferId is string => typeof issuerOfferId === "string",
          )
        : null;
      const snapshot = message.snapshotComplete === true && observedIssuerOfferIds
        ? {
            complete: true as const,
            capturedAt: typeof message.snapshotCapturedAt === "string"
              ? message.snapshotCapturedAt
              : new Date().toISOString(),
            observedIssuerOfferIds,
          }
        : undefined;

      const payload: DetectedOfferSyncPayload = {
        issuer,
        issuerCardId: String(message.cardId ?? message.accountId ?? ""),
        issuerCardName: String(message.cardName ?? ""),
        issuerCardLastDigits: (message.cardLastDigits as string) ?? null,
        snapshot,
        offers: detectedOffers.map((o) => ({
          ...o,
          detectedAt: new Date().toISOString(),
        })),
      };

      return syncDetectedOffersToNextCard(payload);
    },
  }),
);

chrome.runtime.onMessageExternal.addListener(
  createExternalMessageRouter({
    nextCardOrigin: new URL(__NEXTCARD_URL__).origin,
    setAuth,
    resetAuthCache,
    hydrateFromNextCard: async () => {
      await persistedStateHydrated;
      await Promise.all([hydrateFromNextCard(), refreshExtensionProfile()]);
    },
    pullOfferUrlCache,
  }),
);

chrome.alarms.create("pullOfferUrlCache", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pullOfferUrlCache") void pullOfferUrlCache();
});

void getAuth().then((auth) => {
  if (auth) {
    void persistedStateHydrated.then(() =>
      Promise.all([hydrateFromNextCard(), refreshExtensionProfile()])
    ).catch((error) => {
      console.warn("[NextCard SW] Startup hydrate failed:", error);
    });
    void retryPendingOfferSyncs();
    void pullOfferUrlCache();
  }
});
