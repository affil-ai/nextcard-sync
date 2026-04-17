import type { NextCardAuth, ProviderId } from "../lib/types";
import { clearAuth, getAuth, setAuth, startSignIn, verifyAuth } from "../lib/auth";
import {
  deleteFromNextCard,
  pullFromNextCard,
  pushToNextCard,
  validateProviderData,
} from "../lib/sync-to-nextcard";
import { syncOffersToNextCard, retryPendingOfferSyncs, pullOfferUrlCache } from "../lib/sync-offers-to-nextcard";
import type { OfferSyncPayload } from "../lib/sync-offers-to-nextcard";
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

const VERIFY_INTERVAL_MS = 5 * 60 * 1000;
type EnrolledOfferSyncMessage = Omit<OfferSyncPayload["offers"][number], "enrolledAt">;

let lastVerifyAt = 0;
let lastVerifyResult: NextCardAuth | null = null;

const stateStore = createRuntimeStateStore();
const extensionNavigatingTabs = createExtensionNavigationState();

stateStore.hydratePersistedState();

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
}

async function pushScrapedData(providerId: ProviderId, data: unknown) {
  const validated = validateProviderData(providerId, data);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  return pushToNextCard(providerId, validated.data);
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
    syncEnrolledOffers: (issuer, message) => {
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

      // Fire-and-forget — don't block the COMPLETE response
      void syncOffersToNextCard(payload);
    },
  }),
);

chrome.runtime.onMessageExternal.addListener(
  createExternalMessageRouter({
    nextCardOrigin: new URL(__NEXTCARD_URL__).origin,
    setAuth,
    resetAuthCache,
    hydrateFromNextCard,
  }),
);

chrome.alarms.create("pullOfferUrlCache", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pullOfferUrlCache") void pullOfferUrlCache();
});

void getAuth().then((auth) => {
  if (auth) {
    void hydrateFromNextCard().catch((error) => {
      console.warn("[NextCard SW] Startup hydrate failed:", error);
    });
    void retryPendingOfferSyncs();
    void pullOfferUrlCache();
  }
});
