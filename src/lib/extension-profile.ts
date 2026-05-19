import { getAuth } from "./auth";
import type { ExtensionProfile, ProviderId } from "./types";

const STORAGE_KEY = "nextcard_extension_profile";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === "marriott"
    || value === "atmos"
    || value === "chase"
    || value === "aa"
    || value === "delta"
    || value === "united"
    || value === "southwest"
    || value === "ihg"
    || value === "hyatt"
    || value === "amex"
    || value === "capitalone"
    || value === "hilton"
    || value === "frontier"
    || value === "bilt"
    || value === "discover"
    || value === "citi"
  );
}

function normalizeProviderList(value: unknown): ProviderId[] {
  return Array.isArray(value) ? value.filter(isProviderId) : [];
}

export function normalizeExtensionProfile(value: unknown): ExtensionProfile | null {
  if (!isRecord(value)) {
    return null;
  }

  const accountLevel =
    value.accountLevel === "pro" || value.accountLevel === "free"
      ? value.accountLevel
      : null;
  if (!accountLevel) {
    return null;
  }

  return {
    accountLevel,
    allowedProviders: normalizeProviderList(value.allowedProviders),
    lockedProviders: normalizeProviderList(value.lockedProviders),
    upgradeUrl:
      typeof value.upgradeUrl === "string"
        ? value.upgradeUrl
        : "/dashboard/settings?tab=account#billing",
  };
}

export async function getStoredExtensionProfile() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeExtensionProfile(result[STORAGE_KEY]);
}

export async function setStoredExtensionProfile(profile: ExtensionProfile | null) {
  if (!profile) {
    await chrome.storage.local.remove(STORAGE_KEY);
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: profile });
}

export async function fetchExtensionProfile() {
  const auth = await getAuth();
  if (!auth?.token) {
    await setStoredExtensionProfile(null);
    return null;
  }

  const response = await fetch(`${__CONVEX_SITE_URL__}/extension/profile`, {
    method: "GET",
    headers: { Authorization: `Bearer ${auth.token}` },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const profile = normalizeExtensionProfile(await response.json());
  await setStoredExtensionProfile(profile);
  return profile;
}

export async function selectExtensionSyncProvider(providerId: ProviderId) {
  const auth = await getAuth();
  if (!auth?.token) {
    await setStoredExtensionProfile(null);
    return { ok: false, error: "missing_auth", profile: null };
  }

  const response = await fetch(`${__CONVEX_SITE_URL__}/extension/sync-selection`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify({ provider: providerId }),
  });
  const body = await response.json().catch(() => null);
  const profile = normalizeExtensionProfile(
    isRecord(body) && "profile" in body ? body.profile : null,
  );
  if (profile) {
    await setStoredExtensionProfile(profile);
  }

  if (!response.ok) {
    return {
      ok: false,
      error:
        isRecord(body) && typeof body.error === "string"
          ? body.error
          : `HTTP ${response.status}`,
      profile,
    };
  }

  return { ok: true, error: null, profile };
}

export async function getBestAvailableExtensionProfile() {
  try {
    return await fetchExtensionProfile();
  } catch {
    return getStoredExtensionProfile();
  }
}

export function isProviderLocked(profile: ExtensionProfile | null, providerId: ProviderId) {
  return profile?.accountLevel === "free" && profile.lockedProviders.includes(providerId);
}

export function getUpgradeUrl(profile: ExtensionProfile | null) {
  const path = profile?.upgradeUrl ?? "/dashboard/settings?tab=account#billing";
  return new URL(path, __NEXTCARD_URL__).toString();
}
