import type { NextCardAuth, ProviderId, PushToNextCardResult } from "../lib/types";
import {
  clearAuth,
  getAuth,
  getAuthGeneration,
  setAuth,
  startSignIn,
  verifyAuth,
} from "../lib/auth";
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
  deleteHouseholdProviderFromNextCard,
  pullFromNextCard,
  pullHouseholdMemberFromNextCard,
  pushToNextCard,
  validateProviderData,
} from "../lib/sync-to-nextcard";
import {
  createHouseholdSyncTarget,
  getCurrentHouseholdMemberScope,
  getCurrentHouseholdOperationScope,
  getSelectedHouseholdMember,
  getHouseholdRewardsSummariesStorageKey,
  getStoredHouseholdContext,
  householdOperationScopesMatch,
  householdProviderPushScopeIsCurrent,
  isLegacyHouseholdOperationMode,
  refreshHouseholdContext,
  setSelectedHouseholdMember,
  type HouseholdOperationScope,
  type HouseholdSyncTarget,
} from "../lib/household-context";
import { REWARDS_SUMMARIES_STORAGE_KEY } from "../lib/rewards-summary";
import { syncOffersToNextCard, syncDetectedOffersToNextCard, retryPendingOfferSyncs, pullOfferUrlCache } from "../lib/sync-offers-to-nextcard";
import type { OfferSyncPayload, DetectedOfferSyncPayload } from "../lib/sync-offers-to-nextcard";
import { retryPendingOfferActivationCompletions } from "../lib/offer-activation-usage";
import { isOfferIssuer, offerOperationScopeMatches } from "../lib/offer-operation";
import { providerRegistry } from "../providers/provider-registry";
import {
  createMessageRouter,
  createExternalMessageRouter,
  resolveSyncStarter,
} from "./core/message-router";
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
import {
  clearInjectedOfferAlerts,
  initializeMerchantOfferAlertMonitor,
} from "./merchant-offer-alerts";
import { createOfferOperationStore } from "./offer-operation-store";
import { createOfferOperationCoordinator } from "./offer-operation-coordinator";
import { createTravelSyncCoordinator } from "./travel-sync-coordinator";

const VERIFY_INTERVAL_MS = 5 * 60 * 1000;
const BACKEND_PUSH_RETRY_COOLDOWN_MS = 30 * 1000;
type EnrolledOfferSyncMessage = Omit<OfferSyncPayload["offers"][number], "enrolledAt">;

let lastVerifyAt = 0;
let lastVerifyResult: NextCardAuth | null = null;
let pendingProviderRetryPromise: Promise<void> | null = null;
const providersRetriedThisSession = new Set<ProviderId>();
const activeHouseholdTargets = new Map<ProviderId, HouseholdSyncTarget>();
const PENDING_HOUSEHOLD_CONFIRMATION_KEY =
  "pending_household_sync_confirmation_v2";

const stateStore = createRuntimeStateStore();
const offerOperations = createOfferOperationStore();
const offerCoordinator = createOfferOperationCoordinator(
  offerOperations,
  getCurrentHouseholdOperationScope,
  isLegacyHouseholdOperationMode,
);
const extensionNavigatingTabs = createExtensionNavigationState();

const persistedStateHydrated = (async () => {
  const context = await getStoredHouseholdContext();
  const selectedMember = context
    ? await getSelectedHouseholdMember(context)
    : null;
  if (
    context?.capabilities.householdReads
    && context.members.length > 1
    && selectedMember
  ) {
    await stateStore.setHouseholdScope({
      accountScopeId: context.accountScopeId,
      memberId: selectedMember.id,
      memberLifecycleVersion: selectedMember.lifecycleVersion,
      isPrimary: selectedMember.isPrimary,
    });
    const scopedSummaryKey = getHouseholdRewardsSummariesStorageKey(
      context.accountScopeId,
      selectedMember.id,
      selectedMember.lifecycleVersion,
    );
    const stored = await chrome.storage.local.get(scopedSummaryKey);
    await chrome.storage.local.set({
      [REWARDS_SUMMARIES_STORAGE_KEY]: Array.isArray(stored[scopedSummaryKey])
        ? stored[scopedSummaryKey]
        : [],
    });
    return;
  }
  await stateStore.hydratePersistedState();
})();
void offerCoordinator.resume();

async function getCachedAuth() {
  await accountTransition;
  const generation = getAuthGeneration();
  const now = Date.now();
  if (now - lastVerifyAt < VERIFY_INTERVAL_MS) return lastVerifyResult;

  const valid = await verifyAuth();
  if (!valid) {
    const verifiedGeneration = getAuthGeneration();
    await transitionAccount(async () => {
      // Verification can finish after a new login. Only clean up a still signed-out account.
      if (verifiedGeneration === getAuthGeneration() && !(await getAuth())) {
        await onSignOut();
      }
    });
  }
  const auth = await getAuth();
  if (generation !== getAuthGeneration()) return auth;
  lastVerifyAt = now;
  lastVerifyResult = auth;
  return auth;
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
    void chrome.tabs.remove(run.ownedTabId).catch(() => {
      // Users can close the sync tab themselves before the worker gets here.
    });
  }

  stateStore.finishSyncRun(providerId, run.attemptId);
}

async function hydrateFromNextCard() {
  const context = await refreshHouseholdContext()
    ?? await getStoredHouseholdContext();
  const selectedMember = context
    ? await getSelectedHouseholdMember(context)
    : null;
  const useHousehold = Boolean(
    context?.capabilities.householdReads
    && context.members.length > 1
    && selectedMember,
  );
  if (context && selectedMember && useHousehold) {
    await stateStore.setHouseholdScope({
      accountScopeId: context.accountScopeId,
      memberId: selectedMember.id,
      memberLifecycleVersion: selectedMember.lifecycleVersion,
      isPrimary: selectedMember.isPrimary,
    });
  } else {
    await stateStore.setHouseholdScope(null);
  }
  const result = useHousehold && selectedMember
    ? await pullHouseholdMemberFromNextCard(selectedMember.id)
    : await pullFromNextCard();
  if (!result.ok) {
    return;
  }

  if (result.summaries) {
    const updates: Record<string, unknown> = {
      [REWARDS_SUMMARIES_STORAGE_KEY]: result.summaries,
    };
    if (context && selectedMember && useHousehold) {
      updates[getHouseholdRewardsSummariesStorageKey(
        context.accountScopeId,
        selectedMember.id,
        selectedMember.lifecycleVersion,
      )] = result.summaries;
    }
    await chrome.storage.local.set(updates);
  }

  if (!Array.isArray(result.accounts) || result.accounts.length === 0) {
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
    const providerValue: unknown = account.provider;
    if (!stateStore.isProviderId(providerValue)) {
      continue;
    }

    const providerId = providerValue;
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

async function prepareHouseholdSyncTarget(
  providerId: ProviderId,
  expectedScope?: HouseholdOperationScope,
) {
  const target = await createHouseholdSyncTarget(providerId, expectedScope);
  if (!target) {
    activeHouseholdTargets.delete(providerId);
    await stateStore.updateProvider(providerId, { syncTarget: null });
    return null;
  }
  const context = await getStoredHouseholdContext();
  const member = context?.members.find((candidate) => candidate.id === target.memberId);
  if (context && member) {
    await stateStore.setHouseholdScope({
      accountScopeId: context.accountScopeId,
      memberId: member.id,
      memberLifecycleVersion: member.lifecycleVersion,
      isPrimary: member.isPrimary,
    });
  }
  activeHouseholdTargets.set(providerId, target);
  await stateStore.updateProvider(providerId, { syncTarget: target });
  return target;
}

async function getHouseholdPopupState() {
  const context = await refreshHouseholdContext()
    ?? await getStoredHouseholdContext();
  if (!context) return null;
  const selectedMember = await getSelectedHouseholdMember(context);
  const pending = await chrome.storage.local.get(
    PENDING_HOUSEHOLD_CONFIRMATION_KEY,
  );
  const pendingValue = pending[PENDING_HOUSEHOLD_CONFIRMATION_KEY];
  const pendingTarget =
    typeof pendingValue === "object"
    && pendingValue !== null
    && "target" in pendingValue
    && typeof pendingValue.target === "object"
    && pendingValue.target !== null
      ? pendingValue.target
      : null;
  return {
    context,
    selectedMemberId: selectedMember?.id ?? null,
    pendingConfirmation: pendingTarget
      && "memberDisplayName" in pendingTarget
      && typeof pendingTarget.memberDisplayName === "string"
      && "provider" in pendingTarget
      && typeof pendingTarget.provider === "string"
      ? {
          memberDisplayName: pendingTarget.memberDisplayName,
          provider: pendingTarget.provider,
          manualConversionRequired:
            "manualConversionRequired" in pendingValue
            && pendingValue.manualConversionRequired === true,
          collisionMemberDisplayName:
            "collisionMemberDisplayName" in pendingValue
            && typeof pendingValue.collisionMemberDisplayName === "string"
              ? pendingValue.collisionMemberDisplayName
              : null,
        }
      : null,
  };
}

async function switchHouseholdMember(memberId: string) {
  const context = await refreshHouseholdContext()
    ?? await getStoredHouseholdContext();
  const member = context?.members.find((candidate) => candidate.id === memberId);
  if (!context || !member) return { ok: false, error: "member_unavailable" };
  await clearInjectedOfferAlerts();
  await travelSyncCoordinator.cancel();
  for (const providerKey of Object.keys(stateStore.states)) {
    if (!stateStore.isProviderId(providerKey)) continue;
    const providerId = providerKey;
    if (stateStore.getRun(providerId)) {
      await cancelRun(providerId, "Household wallet changed.");
    }
  }
  await offerCoordinator.clearAccountState();
  activeHouseholdTargets.clear();
  await chrome.storage.local.remove(PENDING_HOUSEHOLD_CONFIRMATION_KEY);
  await chrome.storage.local.remove([
    "offerUrlCache",
    "detectedOfferUrlCache",
  ]);
  await chrome.storage.local.set({ [REWARDS_SUMMARIES_STORAGE_KEY]: [] });
  await setSelectedHouseholdMember(member.id);
  await stateStore.setHouseholdScope({
    accountScopeId: context.accountScopeId,
    memberId: member.id,
    memberLifecycleVersion: member.lifecycleVersion,
    isPrimary: member.isPrimary,
  });
  const scopedSummaryKey = getHouseholdRewardsSummariesStorageKey(
    context.accountScopeId,
    member.id,
    member.lifecycleVersion,
  );
  const scopedSummaries = await chrome.storage.local.get(scopedSummaryKey);
  await chrome.storage.local.set({
    [REWARDS_SUMMARIES_STORAGE_KEY]: Array.isArray(
      scopedSummaries[scopedSummaryKey],
    )
      ? scopedSummaries[scopedSummaryKey]
      : [],
  });
  await hydrateFromNextCard();
  await clearInjectedOfferAlerts();
  return { ok: true };
}

async function cancelPendingHouseholdSync() {
  const stored = await chrome.storage.local.get(
    PENDING_HOUSEHOLD_CONFIRMATION_KEY,
  );
  const pending = stored[PENDING_HOUSEHOLD_CONFIRMATION_KEY];
  if (
    typeof pending === "object"
    && pending !== null
    && "target" in pending
    && typeof pending.target === "object"
    && pending.target !== null
    && "provider" in pending.target
    && stateStore.isProviderId(pending.target.provider)
  ) {
    stateStore.updateProvider(pending.target.provider, {
      status: "idle",
      error: null,
      backendSyncStatus: null,
      backendSyncError: null,
      pendingBackendPush: false,
      syncTarget: null,
    });
    activeHouseholdTargets.delete(pending.target.provider);
  }
  await chrome.storage.local.remove(PENDING_HOUSEHOLD_CONFIRMATION_KEY);
  return { ok: true };
}

async function confirmPendingHouseholdSync() {
  const stored = await chrome.storage.local.get(
    PENDING_HOUSEHOLD_CONFIRMATION_KEY,
  );
  const pending = stored[PENDING_HOUSEHOLD_CONFIRMATION_KEY];
  if (
    typeof pending !== "object"
    || pending === null
    || !("target" in pending)
    || typeof pending.target !== "object"
    || pending.target === null
    || !("provider" in pending.target)
    || !stateStore.isProviderId(pending.target.provider)
    || !("memberId" in pending.target)
    || typeof pending.target.memberId !== "string"
    || !("memberDisplayName" in pending.target)
    || typeof pending.target.memberDisplayName !== "string"
    || !("accountScopeId" in pending.target)
    || typeof pending.target.accountScopeId !== "string"
    || !("memberLifecycleVersion" in pending.target)
    || typeof pending.target.memberLifecycleVersion !== "number"
    || !("contextRevision" in pending.target)
    || typeof pending.target.contextRevision !== "string"
    || !("operationId" in pending.target)
    || typeof pending.target.operationId !== "string"
    || !("data" in pending)
  ) {
    return { ok: false, error: "confirmation_not_found" };
  }
  const target: HouseholdSyncTarget = {
    provider: pending.target.provider,
    memberId: pending.target.memberId,
    memberDisplayName: pending.target.memberDisplayName,
    accountScopeId: pending.target.accountScopeId,
    memberLifecycleVersion: pending.target.memberLifecycleVersion,
    contextRevision: pending.target.contextRevision,
    operationId: pending.target.operationId,
  };
  const validated = validateProviderData(target.provider, pending.data);
  if (!validated.ok) return { ok: false, error: validated.error };
  if (
    "collisionMemberId" in pending
    && typeof pending.collisionMemberId === "string"
  ) {
    const switched = await switchHouseholdMember(pending.collisionMemberId);
    if (!switched.ok) return switched;
    const collisionTarget = await prepareHouseholdSyncTarget(target.provider);
    if (!collisionTarget) {
      return { ok: false, error: "member_unavailable" };
    }
    const collisionResult = await pushToNextCard(
      target.provider,
      validated.data,
      { target: collisionTarget },
    );
    updateProviderFromBackendPush(target.provider, collisionResult);
    if (!collisionResult.ok) return collisionResult;
    await hydrateFromNextCard();
    return { ok: true };
  }
  activeHouseholdTargets.set(target.provider, target);
  const result = await pushToNextCard(target.provider, validated.data, {
    target,
    identityConfirmed: true,
    manualConversionConfirmed:
      "manualConversionRequired" in pending &&
      pending.manualConversionRequired === true,
  });
  if (result.manualConversionRequired) {
    await chrome.storage.local.set({
      [PENDING_HOUSEHOLD_CONFIRMATION_KEY]: {
        ...pending,
        manualConversionRequired: true,
      },
    });
    stateStore.updateProvider(target.provider, {
      status: "awaiting_confirmation",
      error: null,
      progressMessage:
        `Review the saved balance conversion for ${target.memberDisplayName}.`,
      backendSyncStatus: null,
      backendSyncError: null,
      pendingBackendPush: false,
    });
    return {
      ok: false,
      error: result.error,
      manualConversionRequired: true,
    };
  }
  updateProviderFromBackendPush(target.provider, result);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      manualConversionRequired: false,
    };
  }
  await chrome.storage.local.remove(PENDING_HOUSEHOLD_CONFIRMATION_KEY);
  await hydrateFromNextCard();
  return { ok: true };
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
  const messages: Record<string, string> = {
    identity_conflict:
      "This provider account is already assigned to another Household profile. Switch profiles or manage the assignment on nextcard.",
    assignment_conflict:
      "This provider account is already assigned to another Household profile. Switch profiles or manage the assignment on nextcard.",
    context_stale:
      "Your Household profiles changed during this sync. Start the sync again with the intended profile.",
    member_unavailable:
      "This Household profile is no longer available for syncing. Choose another profile.",
    member_gone:
      "This Household profile was permanently removed. Choose another profile.",
    extension_writes_disabled:
      "Household rewards sync is temporarily unavailable. Your existing data was not changed.",
    extension_reads_disabled:
      "Household rewards sync is temporarily unavailable. Your existing data was not changed.",
    household_capability_disabled:
      "Household rewards sync is temporarily unavailable. Your existing data was not changed.",
    issuer_member_sync_unsupported:
      "Bank sync for this Household profile is not enabled yet. Switch to Primary or update the extension and try again.",
    extension_upgrade_required:
      "Update the nextcard extension before syncing another Household profile.",
    operation_expired:
      "This sync confirmation expired. Start the sync again.",
    preflight_expired:
      "This sync confirmation expired. Start the sync again.",
    operation_mismatch:
      "The saved sync no longer matches this request. Start the sync again.",
  };
  if (!result.ok && result.error && messages[result.error]) {
    return messages[result.error];
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

  const nonRetryableErrors = new Set([
    "assignment_conflict",
    "identity_conflict",
    "context_stale",
    "member_unavailable",
    "member_gone",
    "extension_writes_disabled",
    "extension_reads_disabled",
    "household_capability_disabled",
    "issuer_member_sync_unsupported",
    "extension_upgrade_required",
    "operation_expired",
    "preflight_expired",
    "operation_mismatch",
    "manual_conversion_required",
  ]);
  const blocked = result.error === "selection_locked"
    || skippedCount > 0
    || (result.error ? nonRetryableErrors.has(result.error) : false);
  const backendSyncStatus = blocked ? "blocked" : "failed";
  stateStore.updateProvider(providerId, {
    status: "error",
    error: backendSyncError,
    lastSyncedAt: null,
    backendSyncStatus,
    backendSyncError,
    pendingBackendPush: !blocked,
    lastBackendPushAttemptAt: attemptedAt,
  });
}

async function recordConsent(message: Record<string, unknown>) {
  const auth = await getCachedAuth();
  if (!auth?.token) {
    console.warn(
      "[NextCard SW] Consent: no auth token available, skipping API call",
    );
    throw new Error("No authenticated nextcard account");
  }

  try {
    const response = await fetch(`${__CONVEX_SITE_URL__}/extension/consent`, {
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
    if (!response.ok) throw new Error(`Consent API returned ${response.status}`);
  } catch {
    console.warn("[NextCard SW] Consent API call failed");
    throw new Error("Consent API call failed");
  }
}

let accountTransition: Promise<void> = Promise.resolve();
function transitionAccount(action: () => Promise<void>): Promise<void> {
  const next = accountTransition.then(action);
  accountTransition = next.catch(() => undefined);
  return next;
}

async function onSignOut() {
  resetAuthCache();
  void clearInjectedOfferAlerts().catch(() => undefined);
  for (const providerKey of Object.keys(stateStore.states)) {
    if (stateStore.isProviderId(providerKey) && stateStore.getRun(providerKey)) {
      await cancelRun(providerKey, "nextcard account changed.");
    }
  }
  stateStore.resetAllStates();
  activeHouseholdTargets.clear();
  const cleanup = await Promise.allSettled([
    setStoredExtensionProfile(null),
    offerCoordinator.clearAccountState(),
    travelSyncCoordinator.clear(),
  ]);
  // Keep account transitions serialized even when one storage operation fails.
  const failed = cleanup.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

function householdSyncTargetsMatch(
  left: HouseholdSyncTarget | null,
  right: HouseholdSyncTarget | null,
) {
  if (!left || !right) return left === right;
  return left.provider === right.provider
    && left.operationId === right.operationId
    && householdOperationScopesMatch(left, right);
}

function providerRunIsCurrent(providerId: ProviderId, attemptId: string | null) {
  return attemptId === null
    ? stateStore.getRun(providerId) === null
    : stateStore.isRunActive(providerId, attemptId);
}

async function providerPushContextIsCurrent(
  providerId: ProviderId,
  target: HouseholdSyncTarget | null,
  fallbackScope: HouseholdOperationScope | null,
  authGeneration: number,
  attemptId: string | null,
) {
  const currentTarget = activeHouseholdTargets.get(providerId)
    ?? stateStore.states[providerId].syncTarget
    ?? null;
  if (
    getAuthGeneration() !== authGeneration
    || !providerRunIsCurrent(providerId, attemptId)
    || !householdSyncTargetsMatch(target, currentTarget)
  ) return false;

  const currentScope = await getCurrentHouseholdMemberScope();
  const legacyMode = target || fallbackScope
    ? false
    : await isLegacyHouseholdOperationMode();
  const scopeIsCurrent = householdProviderPushScopeIsCurrent(
    target,
    fallbackScope,
    currentScope,
    legacyMode,
  );
  const latestTarget = activeHouseholdTargets.get(providerId)
    ?? stateStore.states[providerId].syncTarget
    ?? null;
  return scopeIsCurrent
    && getAuthGeneration() === authGeneration
    && providerRunIsCurrent(providerId, attemptId)
    && householdSyncTargetsMatch(target, latestTarget);
}

async function pushScrapedData(providerId: ProviderId, data: unknown) {
  const authGeneration = getAuthGeneration();
  const attemptId = stateStore.getRun(providerId)?.attemptId ?? null;
  const target = activeHouseholdTargets.get(providerId)
    ?? stateStore.states[providerId].syncTarget
    ?? null;
  const fallbackScope = target
    ? null
    : await getCurrentHouseholdMemberScope();
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

  const result = await pushToNextCard(providerId, validated.data, { target });
  if (!await providerPushContextIsCurrent(
    providerId,
    target,
    fallbackScope,
    authGeneration,
    attemptId,
  )) {
    return { ok: false, error: "sync_cancelled" };
  }
  if (
    target
    && (result.error === "identity_conflict"
      || result.error === "assignment_conflict")
    && result.existingMemberId
  ) {
    const context = await getStoredHouseholdContext();
    const collisionMember = context?.members.find(
      (member) => member.id === result.existingMemberId,
    );
    if (collisionMember) {
      await chrome.storage.local.set({
        [PENDING_HOUSEHOLD_CONFIRMATION_KEY]: {
          target,
          data: validated.data,
          collisionMemberId: collisionMember.id,
          collisionMemberDisplayName: collisionMember.displayName,
        },
      });
      stateStore.updateProvider(providerId, {
        status: "awaiting_confirmation",
        error: null,
        progressMessage:
          `This account appears to belong to ${collisionMember.displayName}.`,
        backendSyncStatus: null,
        backendSyncError: null,
        pendingBackendPush: false,
        lastBackendPushAttemptAt: new Date().toISOString(),
      });
      return { ...result, awaitingConfirmation: true };
    }
  }
  if (
    target
    && (result.confirmationRequired || result.manualConversionRequired)
  ) {
    await chrome.storage.local.set({
      [PENDING_HOUSEHOLD_CONFIRMATION_KEY]: {
        target,
        data: validated.data,
        manualConversionRequired: result.manualConversionRequired === true,
      },
    });
    const confirmationMessage = result.manualConversionRequired
      ? `Confirm converting the saved balance and syncing ${providerId} for ${target.memberDisplayName}.`
      : `Confirm this ${providerId} account belongs to ${target.memberDisplayName}.`;
    stateStore.updateProvider(providerId, {
      status: "awaiting_confirmation",
      error: null,
      progressMessage: confirmationMessage,
      backendSyncStatus: null,
      backendSyncError: null,
      pendingBackendPush: false,
      lastBackendPushAttemptAt: new Date().toISOString(),
    });
    return { ...result, awaitingConfirmation: true };
  }
  updateProviderFromBackendPush(providerId, result);
  if (result.ok) {
    try {
      await hydrateFromNextCard();
    } catch (error) {
      console.warn(
        "[NextCard SW] Rewards summary refresh after sync failed:",
        error,
      );
    }
  }
  if (!result.ok && result.error === "selection_locked") {
    await refreshExtensionProfile();
  }
  return result;
}

async function deleteProviderFromNextCard(providerId: ProviderId, expectedScope?: HouseholdOperationScope) {
  // Deletion is its own immutable operation. Never reuse the operation ID from
  // the sync that originally created the provider account.
  const target = await createHouseholdSyncTarget(providerId, expectedScope);
  const result = target
    ? await deleteHouseholdProviderFromNextCard(target)
    : await deleteFromNextCard(providerId);
  if (result.ok) {
    stateStore.updateProvider(providerId, {
      status: "idle",
      data: null,
      error: null,
      lastSyncedAt: null,
      progressMessage: null,
      backendSyncStatus: null,
      backendSyncError: null,
      pendingBackendPush: false,
      lastBackendPushAttemptAt: null,
    });
    try {
      await hydrateFromNextCard();
    } catch (error) {
      console.warn(
        "[NextCard SW] Rewards summary refresh after delete failed:",
        error,
      );
    }
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
    const householdContext = await getStoredHouseholdContext();
    const householdRetryRequiresTarget = Boolean(
      householdContext?.capabilities.householdReads
      && householdContext.members.length > 1,
    );
    for (const providerId of Object.keys(stateStore.states) as ProviderId[]) {
      const state = stateStore.states[providerId];
      if (!state.pendingBackendPush || !state.data) continue;
      if (stateStore.getRun(providerId)) continue;
      if (providersRetriedThisSession.has(providerId)) continue;
      if (state.backendSyncStatus === "blocked" && !options.includeBlocked) continue;
      if (householdRetryRequiresTarget && !state.syncTarget) continue;

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
    refreshOfferUrlCache: pullPrimaryOfferUrlCache,
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

async function providerIsLocked(providerId: ProviderId) {
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
}

async function startProviderForTravelSync(providerId: ProviderId) {
  await persistedStateHydrated;
  const status = stateStore.states[providerId].status;
  if (
    stateStore.getRun(providerId)
    || status === "detecting_login"
    || status === "waiting_for_login"
    || status === "extracting"
  ) {
    return true;
  }
  if (await providerIsLocked(providerId)) return false;

  const startSync = resolveSyncStarter(providerId, providerRegistry, syncHandlers);
  void startSync().catch((error) => {
    const errorMessage = error instanceof Error ? error.message : "Sync failed";
    stateStore.updateProvider(providerId, {
      status: "error",
      error: errorMessage,
      progressMessage: null,
    });
  });
  return stateStore.waitForSyncStart(providerId);
}

async function waitForTravelProviderCompletion(providerId: ProviderId) {
  while (true) {
    const state = stateStore.states[providerId];
    const active = state.status === "detecting_login"
      || state.status === "waiting_for_login"
      || state.status === "extracting"
      || state.status === "awaiting_confirmation";
    if (!active) {
      return {
        succeeded:
          state.status === "done"
          && state.pendingBackendPush !== true
          && state.backendSyncStatus !== "partial"
          && state.backendSyncStatus !== "blocked"
          && state.backendSyncStatus !== "failed",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

const travelSyncCoordinator = createTravelSyncCoordinator({
  storage: chrome.storage.local,
  isProviderId: stateStore.isProviderId,
  prepareProvider: async (providerId, scope) => {
    try {
      await prepareHouseholdSyncTarget(providerId, scope ?? undefined);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "household_scope_changed") {
        return false;
      }
      throw error;
    }
  },
  startProvider: startProviderForTravelSync,
  waitForCompletion: waitForTravelProviderCompletion,
  cancelProvider: (providerId) => cancelRun(providerId),
  getCurrentScope: getCurrentHouseholdOperationScope,
});

void persistedStateHydrated.then(() => travelSyncCoordinator.resume());

async function pullPrimaryOfferUrlCache() {
  const context = await getStoredHouseholdContext();
  const selectedMember = context
    ? await getSelectedHouseholdMember(context)
    : null;
  if (
    context &&
    selectedMember &&
    !selectedMember.isPrimary &&
    !context.capabilities.memberOfferReads
  ) {
    await chrome.storage.local.remove(["offerUrlCache", "detectedOfferUrlCache"]);
    return;
  }
  return pullOfferUrlCache(await getCurrentHouseholdOperationScope());
}

async function canCurrentMemberWriteOffers() {
  const context = await getStoredHouseholdContext();
  const selectedMember = context
    ? await getSelectedHouseholdMember(context)
    : null;
  return !context || !selectedMember || selectedMember.isPrimary
    || context.capabilities.memberOfferWrites;
}

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
void initializeMerchantOfferAlertMonitor();

chrome.runtime.onMessage.addListener(
  createMessageRouter({
    providerRegistry,
    stateStore,
    syncHandlers,
    cancelRun,
    startSignIn,
    signOut: () => transitionAccount(async () => {
      await clearAuth();
      await onSignOut();
    }),
    getCachedAuth,
    recordConsent,
    pushToNextCard: pushScrapedData,
    deleteFromNextCard: deleteProviderFromNextCard,
    isProviderLocked: providerIsLocked,
    prepareSyncTarget: async (providerId, expectedScope) =>
      Boolean(await prepareHouseholdSyncTarget(providerId, expectedScope)),
    confirmHouseholdSync: confirmPendingHouseholdSync,
    cancelHouseholdSyncConfirmation: cancelPendingHouseholdSync,
    switchHouseholdMember,
    getHouseholdState: getHouseholdPopupState,
    getExtensionProfile: getStoredExtensionProfile,
    refreshExtensionProfile,
    openUpgrade: openUpgradeTab,
    canWriteOffers: canCurrentMemberWriteOffers,
    offerOperations,
    offerCoordinator,
    startLegacyOfferOperation: async (issuer) => {
      const scope = await getCurrentHouseholdOperationScope();
      if (scope || await isLegacyHouseholdOperationMode()) {
        return offerOperations.start(issuer, scope);
      }
      return { ok: false as const, error: "account_scope_unavailable" };
    },
    travelSyncCoordinator,
    syncEnrolledOffers: async (issuer, message) => {
      const runId = typeof message.runId === "string" ? message.runId : null;
      const operation = runId && isOfferIssuer(issuer)
        ? await offerOperations.getRun(issuer, runId)
        : null;
      if (!operation) throw new Error("stale_offer_operation");
      if (!offerOperationScopeMatches(
        operation,
        await getCurrentHouseholdOperationScope(),
      )) {
        throw new Error("stale_offer_operation");
      }
      const context = await getStoredHouseholdContext();
      const selectedMember = context
        ? await getSelectedHouseholdMember(context)
        : null;
      if (
        context &&
        selectedMember &&
        !selectedMember.isPrimary &&
        !context.capabilities.memberOfferWrites
      ) {
        throw new Error(
          "Card-offer saving is temporarily unavailable for this household profile.",
        );
      }
      // Reuse the sync payload shape so message handlers stay aligned with backend expectations.
      const enrolledOffers = message.enrolledOffers as EnrolledOfferSyncMessage[];

      const payload: OfferSyncPayload = {
        runId: operation.runId,
        scope: operation.scope,
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
      const syncResult = await syncOffersToNextCard(payload);
      if (syncResult.status === "failed") {
        throw new Error(
          syncResult.error ?? "Couldn’t save the verified offers to nextcard.",
        );
      }
      return syncResult.status;
    },
    syncDetectedOffers: async (issuer, message) => {
      const runId = typeof message.runId === "string" ? message.runId : null;
      const operation = runId && isOfferIssuer(issuer)
        ? await offerOperations.getRun(issuer, runId)
        : null;
      if (!operation) throw new Error("stale_offer_operation");
      if (!offerOperationScopeMatches(
        operation,
        await getCurrentHouseholdOperationScope(),
      )) {
        throw new Error("stale_offer_operation");
      }
      const context = await getStoredHouseholdContext();
      const selectedMember = context
        ? await getSelectedHouseholdMember(context)
        : null;
      if (
        context &&
        selectedMember &&
        !selectedMember.isPrimary &&
        !context.capabilities.memberOfferWrites
      ) {
        throw new Error(
          "Detected-offer saving is temporarily unavailable for this household profile.",
        );
      }
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
        runId: operation.runId,
        scope: operation.scope,
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
    setAuth: (auth) => transitionAccount(async () => {
      // Invalidate old credentials and runs before accepting another account.
      await clearAuth();
      await onSignOut();
      await setAuth(auth);
    }),
    resetAuthCache,
    hydrateFromNextCard: async () => {
      await persistedStateHydrated;
      await Promise.all([hydrateFromNextCard(), refreshExtensionProfile()]);
    },
    pullOfferUrlCache: pullPrimaryOfferUrlCache,
  }),
);

chrome.alarms.create("pullOfferUrlCache", { periodInMinutes: 30 });
chrome.alarms.create("retryOfferActivationCompletions", {
  periodInMinutes: 5,
});
chrome.alarms.create("retryPendingOfferSyncs", {
  periodInMinutes: 5,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pullOfferUrlCache") void pullPrimaryOfferUrlCache();
  if (alarm.name === "retryPendingOfferSyncs") void retryQueuedOfferSyncs();
  if (alarm.name === "retryOfferActivationCompletions") {
    void retryPendingOfferActivationCompletions();
  }
});

async function retryQueuedOfferSyncs() {
  const context = await getStoredHouseholdContext();
  const selectedMember = context
    ? await getSelectedHouseholdMember(context)
    : null;
  if (
    context &&
    selectedMember &&
    !selectedMember.isPrimary &&
    !context.capabilities.memberOfferWrites
  ) return;
  const result = await retryPendingOfferSyncs(
    await getCurrentHouseholdOperationScope(),
  );
  await Promise.all(result.savedRunIds.map(async (runId) => {
    await offerOperations.patch(runId, {
      saveStatus: "saved",
      saveError: null,
    });
    await offerOperations.continueAfterEnrollmentCompletion(runId);
    void offerCoordinator.resume();
  }));
  await Promise.all(result.failedRunIds.map((runId) =>
    offerOperations.patch(runId, {
      saveStatus: "failed",
      saveError:
        "This offer save no longer matches the selected household profile. Check offers again.",
    })
  ));
}

void getAuth().then((auth) => {
  if (auth) {
    void persistedStateHydrated.then(() =>
      Promise.all([hydrateFromNextCard(), refreshExtensionProfile()])
    ).catch((error) => {
      console.warn("[NextCard SW] Startup hydrate failed:", error);
    });
    void retryQueuedOfferSyncs();
    void retryPendingOfferActivationCompletions();
    void pullPrimaryOfferUrlCache();
  }
});
