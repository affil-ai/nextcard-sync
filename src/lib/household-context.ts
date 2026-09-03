import { getAuth } from "./auth";
import type { ProviderId } from "./types";

export const HOUSEHOLD_CONTEXT_STORAGE_KEY = "nextcard_household_context_v2";
export const HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY =
  "nextcard_household_selected_member_v2";

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
  };
  members: HouseholdExtensionMember[];
}

export interface HouseholdSyncTarget {
  accountScopeId: string;
  memberId: string;
  memberDisplayName: string;
  provider: ProviderId;
  contextRevision: string;
  operationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

    const previous = await getStoredHouseholdContext();
    if (previous && previous.accountScopeId !== context.accountScopeId) {
      await chrome.storage.local.remove(HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY);
    }
    await chrome.storage.local.set({
      [HOUSEHOLD_CONTEXT_STORAGE_KEY]: context,
    });
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

export async function createHouseholdSyncTarget(provider: ProviderId) {
  const context = await refreshHouseholdContext()
    ?? await getStoredHouseholdContext();
  if (
    !context
    || !context.capabilities.householdReads
    || context.members.length < 2
  ) {
    return null;
  }
  if (!isExtensionVersionSupported(
    chrome.runtime.getManifest().version,
    context.minimumExtensionVersion,
  )) {
    throw new Error("extension_upgrade_required");
  }
  const member = await getSelectedHouseholdMember(context);
  if (!member) throw new Error("Select a household member before syncing.");
  if (!context.capabilities.householdWrites) {
    if (member.isPrimary) return null;
    throw new Error("extension_writes_disabled");
  }
  return {
    accountScopeId: context.accountScopeId,
    memberId: member.id,
    memberDisplayName: member.displayName,
    provider,
    contextRevision: context.contextRevision,
    operationId: crypto.randomUUID(),
  } satisfies HouseholdSyncTarget;
}

export function getHouseholdProviderStorageKey(
  accountScopeId: string,
  memberId: string,
  provider: ProviderId,
) {
  return ["provider_v2", accountScopeId, memberId, provider]
    .map(encodeURIComponent)
    .join("::");
}

export function getHouseholdRewardsSummariesStorageKey(
  accountScopeId: string,
  memberId: string,
) {
  return ["rewards_summaries_v2", accountScopeId, memberId]
    .map(encodeURIComponent)
    .join("::");
}
