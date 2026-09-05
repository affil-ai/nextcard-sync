import { getAuth, getAuthGeneration } from "./auth";
import type { ProviderId } from "./types";

export const HOUSEHOLD_CONTEXT_STORAGE_KEY = "nextcard_household_context_v2";
export const HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY =
  "nextcard_household_selected_member_v2";
const LEGACY_OFFER_MIGRATION_NOTICE_KEY =
  "nextcard_legacy_offer_queue_migration_v2";
const HOUSEHOLD_CONTEXT_WRITE_TOKEN_KEY =
  "nextcard_household_context_write_token_v2";
let legacyOfferMigrationQueue: Promise<void> = Promise.resolve();

export interface HouseholdExtensionMember {
  id: string;
  displayName: string;
  isPrimary: boolean;
  lifecycleVersion: number;
}

export interface HouseholdExtensionContext {
  protocolVersion: number;
  minimumExtensionVersion: string;
  recommendedExtensionVersion: string;
  accountScopeId: string;
  contextRevision: string;
  primaryMemberId: string | null;
  householdActivated: boolean;
  capabilities: {
    householdReads: boolean;
    householdWrites: boolean;
    loyaltyReads: boolean;
    loyaltyWrites: boolean;
    memberIssuerCardSync: boolean;
    memberOfferReads: boolean;
    memberOfferWrites: boolean;
    combinedReads: boolean;
  };
  members: HouseholdExtensionMember[];
}

export interface HouseholdSyncTarget {
  accountScopeId: string;
  memberId: string;
  memberDisplayName: string;
  memberLifecycleVersion: number;
  provider: ProviderId;
  contextRevision: string;
  operationId: string;
}

export type HouseholdOperationScope = Omit<
  HouseholdSyncTarget,
  "provider" | "operationId"
>;

export function parseHouseholdOperationScope(value: unknown): HouseholdOperationScope | undefined {
  if (!isRecord(value)
    || typeof value.accountScopeId !== "string"
    || typeof value.memberId !== "string"
    || typeof value.memberDisplayName !== "string"
    || typeof value.memberLifecycleVersion !== "number"
    || typeof value.contextRevision !== "string") return undefined;
  return {
    accountScopeId: value.accountScopeId,
    memberId: value.memberId,
    memberDisplayName: value.memberDisplayName,
    memberLifecycleVersion: value.memberLifecycleVersion,
    contextRevision: value.contextRevision,
  };
}

export function householdOperationScopesMatch(
  left: HouseholdOperationScope,
  right: HouseholdOperationScope,
) {
  return left.accountScopeId === right.accountScopeId
    && left.memberId === right.memberId
    && left.memberLifecycleVersion === right.memberLifecycleVersion
    && left.contextRevision === right.contextRevision;
}

export function householdProviderPushScopeIsCurrent(
  target: HouseholdSyncTarget | null,
  fallbackScope: HouseholdOperationScope | null,
  currentScope: HouseholdOperationScope | null,
  legacyMode: boolean,
) {
  const expectedScope = target ?? fallbackScope;
  return expectedScope
    ? currentScope !== null
      && householdOperationScopesMatch(expectedScope, currentScope)
    : currentScope === null && legacyMode;
}

export async function getCurrentHouseholdOperationScope(): Promise<
  HouseholdOperationScope | null
> {
  const context = await getStoredHouseholdContext()
    ?? await refreshHouseholdContext();
  if (
    !context
    || !context.householdActivated
    || !context.capabilities.householdReads
    || context.members.length < 2
  ) return null;
  const member = await getSelectedHouseholdMember(context);
  if (!member) return null;
  if (member.isPrimary && !context.capabilities.memberOfferWrites) return null;
  const scope = {
    accountScopeId: context.accountScopeId,
    memberId: member.id,
    memberDisplayName: member.displayName,
    memberLifecycleVersion: member.lifecycleVersion,
    contextRevision: context.contextRevision,
  };
  const primaryMember = context.members.find(
    (candidate) => candidate.id === context.primaryMemberId,
  );
  if (primaryMember) {
    await migrateLegacyOfferStorage({
      accountScopeId: context.accountScopeId,
      memberId: primaryMember.id,
      memberDisplayName: primaryMember.displayName,
      memberLifecycleVersion: primaryMember.lifecycleVersion,
      contextRevision: context.contextRevision,
    });
  }
  return scope;
}

export async function getCurrentHouseholdMemberScope(): Promise<
  HouseholdOperationScope | null
> {
  const context = await getStoredHouseholdContext()
    ?? await refreshHouseholdContext();
  if (
    !context
    || !context.householdActivated
    || !context.capabilities.householdReads
    || context.members.length < 2
  ) return null;
  const member = await getSelectedHouseholdMember(context);
  if (!member) return null;
  return {
    accountScopeId: context.accountScopeId,
    memberId: member.id,
    memberDisplayName: member.displayName,
    memberLifecycleVersion: member.lifecycleVersion,
    contextRevision: context.contextRevision,
  };
}

export async function isLegacyHouseholdOperationMode() {
  const context = await getStoredHouseholdContext()
    ?? await refreshHouseholdContext();
  const selectedMember = context
    ? await getSelectedHouseholdMember(context)
    : null;
  const stored = await chrome.storage.local.get(HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY);
  if (typeof stored[HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY] === "string" && !selectedMember) return false;
  return Boolean(
    context
    && (
      !context.householdActivated
      || !context.capabilities.householdReads
      || context.members.length < 2
      || (selectedMember?.isPrimary === true
        && !context.capabilities.memberOfferWrites)
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function storageValuesEqual(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

async function migrateLegacyOfferStorage(scope: HouseholdOperationScope | null) {
  const task = async () => {
    const generation = getAuthGeneration();
    const auth = await getAuth();
    if (!auth) return;
    const enrolledKey = scope
      ? getHouseholdScopedStorageKey("pendingOfferSyncs", scope)
      : null;
    const stored = await chrome.storage.local.get([
      "pendingOfferSyncs",
      "pendingDetectedOfferSyncs",
      "offerUrlCache",
      "detectedOfferUrlCache",
      ...(enrolledKey ? [enrolledKey] : []),
    ]);
    const legacyEnrolled = Array.isArray(stored.pendingOfferSyncs)
      ? stored.pendingOfferSyncs.filter(isRecord)
      : [];
    const existingEnrolled = enrolledKey && Array.isArray(stored[enrolledKey])
      ? stored[enrolledKey]
      : [];
    const discardedDetectedCount = Array.isArray(stored.pendingDetectedOfferSyncs)
      ? stored.pendingDetectedOfferSyncs.length
      : 0;
    if (getAuthGeneration() !== generation) return;
    const migratedEnrolled = scope ? [
      ...existingEnrolled,
      ...legacyEnrolled.map((payload) => ({ ...payload, scope })),
    ] : [];
    if (enrolledKey && legacyEnrolled.length > 0) {
      await chrome.storage.local.set({
        [enrolledKey]: migratedEnrolled,
      });
    }
    const legacyKeys = [
      "pendingOfferSyncs",
      "pendingDetectedOfferSyncs",
      "offerUrlCache",
      "detectedOfferUrlCache",
    ].filter((key) => key in stored);
    const cleanMigratedDestination = async () => {
      if (!enrolledKey) return;
      const latest = await chrome.storage.local.get(enrolledKey);
      if (storageValuesEqual(latest[enrolledKey], migratedEnrolled)) {
        await chrome.storage.local.remove(enrolledKey);
      }
    };
    if (getAuthGeneration() !== generation) {
      await cleanMigratedDestination();
      return;
    }
    if (legacyKeys.length > 0) {
      const latestLegacy = await chrome.storage.local.get(legacyKeys);
      if (
        getAuthGeneration() !== generation
        || legacyKeys.some((key) =>
          !storageValuesEqual(latestLegacy[key], stored[key])
        )
      ) {
        if (getAuthGeneration() !== generation) {
          await cleanMigratedDestination();
        }
        return;
      }
      const notice = {
        migratedEnrolledCount: scope ? legacyEnrolled.length : 0,
        discardedEnrolledCount: scope ? 0 : legacyEnrolled.length,
        discardedDetectedCount,
        migratedAt: new Date().toISOString(),
      };
      await chrome.storage.local.set({
        [LEGACY_OFFER_MIGRATION_NOTICE_KEY]: notice,
      });
      const latestBeforeRemoval = await chrome.storage.local.get(legacyKeys);
      if (
        getAuthGeneration() !== generation
        || legacyKeys.some((key) =>
          !storageValuesEqual(latestBeforeRemoval[key], stored[key])
        )
      ) {
        const latestNotice = await chrome.storage.local.get(
          LEGACY_OFFER_MIGRATION_NOTICE_KEY,
        );
        if (storageValuesEqual(
          latestNotice[LEGACY_OFFER_MIGRATION_NOTICE_KEY],
          notice,
        )) {
          await chrome.storage.local.remove(LEGACY_OFFER_MIGRATION_NOTICE_KEY);
        }
        if (getAuthGeneration() !== generation) {
          await cleanMigratedDestination();
        }
        return;
      }
      await chrome.storage.local.remove(legacyKeys);
    }
    if (enrolledKey && getAuthGeneration() !== generation) {
      const latest = await chrome.storage.local.get(enrolledKey);
      if (storageValuesEqual(latest[enrolledKey], migratedEnrolled)) {
        await chrome.storage.local.remove(enrolledKey);
      }
    }
  };
  legacyOfferMigrationQueue = legacyOfferMigrationQueue.then(task, task);
  await legacyOfferMigrationQueue;
}

function parseMember(value: unknown): HouseholdExtensionMember | null {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.displayName !== "string"
    || typeof value.isPrimary !== "boolean"
    || typeof value.lifecycleVersion !== "number"
  ) {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    isPrimary: value.isPrimary,
    lifecycleVersion: value.lifecycleVersion,
  };
}

export function parseHouseholdExtensionContext(
  value: unknown,
): HouseholdExtensionContext | null {
  if (
    !isRecord(value)
    || value.protocolVersion !== 2
    || typeof value.minimumExtensionVersion !== "string"
    || typeof value.recommendedExtensionVersion !== "string"
    || typeof value.accountScopeId !== "string"
    || typeof value.contextRevision !== "string"
    || (value.primaryMemberId !== null && typeof value.primaryMemberId !== "string")
    || typeof value.householdActivated !== "boolean"
    || !isRecord(value.capabilities)
    || typeof value.capabilities.householdReads !== "boolean"
    || typeof value.capabilities.householdWrites !== "boolean"
    || !Array.isArray(value.members)
  ) {
    return null;
  }
  const members = value.members.map(parseMember);
  if (members.some((member) => member === null)) return null;
  return {
    protocolVersion: value.protocolVersion,
    minimumExtensionVersion: value.minimumExtensionVersion,
    recommendedExtensionVersion: value.recommendedExtensionVersion,
    accountScopeId: value.accountScopeId,
    contextRevision: value.contextRevision,
    primaryMemberId: value.primaryMemberId,
    householdActivated: value.householdActivated,
    capabilities: {
      householdReads: value.capabilities.householdReads,
      householdWrites: value.capabilities.householdWrites,
      loyaltyReads:
        typeof value.capabilities.loyaltyReads === "boolean"
          ? value.capabilities.loyaltyReads
          : value.capabilities.householdReads,
      loyaltyWrites:
        typeof value.capabilities.loyaltyWrites === "boolean"
          ? value.capabilities.loyaltyWrites
          : value.capabilities.householdWrites,
      memberIssuerCardSync:
        value.capabilities.memberIssuerCardSync === true,
      memberOfferReads: value.capabilities.memberOfferReads === true,
      memberOfferWrites: value.capabilities.memberOfferWrites === true,
      combinedReads: value.capabilities.combinedReads === true,
    },
    members: members.filter(
      (member): member is HouseholdExtensionMember => member !== null,
    ),
  };
}

export function isExtensionVersionSupported(
  currentVersion: string,
  minimumVersion: string,
) {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match
      ? [Number(match[1]), Number(match[2]), Number(match[3])]
      : null;
  };
  const current = parse(currentVersion);
  const minimum = parse(minimumVersion);
  if (!current || !minimum) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

export async function getStoredHouseholdContext() {
  const stored = await chrome.storage.local.get(HOUSEHOLD_CONTEXT_STORAGE_KEY);
  return parseHouseholdExtensionContext(stored[HOUSEHOLD_CONTEXT_STORAGE_KEY]);
}

export async function refreshHouseholdContext() {
  const generation = getAuthGeneration();
  const auth = await getAuth();
  if (!auth) return null;
  try {
    const response = await fetch(`${__CONVEX_SITE_URL__}/extension/v2/context`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "X-Nextcard-Extension-Version": chrome.runtime.getManifest().version,
        "X-Nextcard-Protocol-Version": "2",
      },
    });
    if (!response.ok) return null;
    const context = parseHouseholdExtensionContext(await response.json());
    if (!context) return null;
    const currentAuth = await getAuth();
    if (
      getAuthGeneration() !== generation
      || currentAuth?.token !== auth.token
    ) return null;

    const previous = await getStoredHouseholdContext();
    if (previous && previous.accountScopeId !== context.accountScopeId) {
      await chrome.storage.local.remove(HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY);
    }
    const writeToken = crypto.randomUUID();
    await chrome.storage.local.set({
      [HOUSEHOLD_CONTEXT_STORAGE_KEY]: context,
      [HOUSEHOLD_CONTEXT_WRITE_TOKEN_KEY]: writeToken,
    });
    const persistedAuth = await getAuth();
    if (
      getAuthGeneration() !== generation
      || persistedAuth?.token !== auth.token
    ) {
      const stored = await chrome.storage.local.get([
        HOUSEHOLD_CONTEXT_STORAGE_KEY,
        HOUSEHOLD_CONTEXT_WRITE_TOKEN_KEY,
      ]);
      if (
        stored[HOUSEHOLD_CONTEXT_WRITE_TOKEN_KEY] === writeToken
      ) {
        await chrome.storage.local.remove([
          HOUSEHOLD_CONTEXT_STORAGE_KEY,
          HOUSEHOLD_CONTEXT_WRITE_TOKEN_KEY,
        ]);
      }
      return null;
    }
    return context;
  } catch {
    return null;
  }
}

export async function getSelectedHouseholdMember(
  context: HouseholdExtensionContext,
) {
  const stored = await chrome.storage.local.get(
    HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY,
  );
  const selectedId = stored[HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY];
  const selected = context.members.find((member) => member.id === selectedId);
  if (typeof selectedId === "string" && !selected) return null;
  return selected
    ?? context.members.find((member) => member.id === context.primaryMemberId)
    ?? context.members[0]
    ?? null;
}

export async function setSelectedHouseholdMember(memberId: string) {
  await chrome.storage.local.set({
    [HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY]: memberId,
  });
}

export async function createHouseholdSyncTarget(
  provider: ProviderId,
  expectedScope?: HouseholdOperationScope,
) {
  // Freeze intent before refreshing. A missing selection is not permission to
  // retarget a write to Primary, even when only Primary remains in the household.
  const previous = await getStoredHouseholdContext();
  const selected = await chrome.storage.local.get(HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY);
  const selectedId = selected[HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY];
  const previousMember = previous ? await getSelectedHouseholdMember(previous) : null;
  const frozenScope = expectedScope ?? (previous && previousMember ? {
    accountScopeId: previous.accountScopeId,
    memberId: previousMember.id,
    memberDisplayName: previousMember.displayName,
    memberLifecycleVersion: previousMember.lifecycleVersion,
    contextRevision: previous.contextRevision,
  } : undefined);
  const context = await refreshHouseholdContext();
  if (!context) throw new Error("household_context_unavailable");
  const member = await getSelectedHouseholdMember(context);
  if (typeof selectedId === "string" && (!member || member.id !== selectedId)) {
    throw new Error("household_scope_changed");
  }
  if (frozenScope && (!member || !householdOperationScopesMatch(frozenScope, {
    accountScopeId: context.accountScopeId,
    memberId: member.id,
    memberDisplayName: member.displayName,
    memberLifecycleVersion: member.lifecycleVersion,
    contextRevision: context.contextRevision,
  }))) throw new Error("household_scope_changed");
  if (
    !context
    || !context.capabilities.householdReads
    || context.members.length < 2
  ) {
    if (frozenScope && (!member?.isPrimary || !context.capabilities.householdReads)) {
      throw new Error("household_scope_changed");
    }
    return null;
  }
  if (!isExtensionVersionSupported(
    chrome.runtime.getManifest().version,
    context.minimumExtensionVersion,
  )) {
    throw new Error("extension_upgrade_required");
  }
  if (!member) throw new Error("Select a household member before syncing.");
  const currentScope: HouseholdOperationScope = {
    accountScopeId: context.accountScopeId,
    memberId: member.id,
    memberDisplayName: member.displayName,
    memberLifecycleVersion: member.lifecycleVersion,
    contextRevision: context.contextRevision,
  };
  if (
    expectedScope
    && !householdOperationScopesMatch(expectedScope, currentScope)
  ) {
    throw new Error("household_scope_changed");
  }
  const isIssuer = [
    "chase",
    "amex",
    "capitalone",
    "bilt",
    "discover",
    "citi",
  ].includes(provider);
  const writesEnabled = isIssuer
    ? context.capabilities.memberIssuerCardSync
    : context.capabilities.loyaltyWrites;
  if (!writesEnabled) {
    if (member.isPrimary) return null;
    throw new Error(
      isIssuer ? "issuer_member_sync_unsupported" : "extension_writes_disabled",
    );
  }
  return {
    ...currentScope,
    provider,
    contextRevision: context.contextRevision,
    operationId: crypto.randomUUID(),
  } satisfies HouseholdSyncTarget;
}

export function getHouseholdProviderStorageKey(
  accountScopeId: string,
  memberId: string,
  memberLifecycleVersion: number,
  provider: ProviderId,
) {
  return [
    "provider_v2",
    accountScopeId,
    memberId,
    String(memberLifecycleVersion),
    provider,
  ]
    .map(encodeURIComponent)
    .join("::");
}

export function getHouseholdRewardsSummariesStorageKey(
  accountScopeId: string,
  memberId: string,
  memberLifecycleVersion: number,
) {
  return [
    "rewards_summaries_v2",
    accountScopeId,
    memberId,
    String(memberLifecycleVersion),
  ]
    .map(encodeURIComponent)
    .join("::");
}

export function getHouseholdScopedStorageKey(
  baseKey: string,
  scope: HouseholdOperationScope | null | undefined,
) {
  if (!scope) return baseKey;
  return [
    baseKey,
    scope.accountScopeId,
    scope.memberId,
    String(scope.memberLifecycleVersion),
  ]
    .map(encodeURIComponent)
    .join("::");
}
