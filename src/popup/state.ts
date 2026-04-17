import type {
  NextCardAuth,
  ProviderId,
  ProviderStateMap,
  ProviderSyncState,
  SyncStatus,
} from "../lib/types";
import {
  aaProviderDataSchema,
  amexProviderDataSchema,
  atmosProviderDataSchema,
  biltProviderDataSchema,
  capitalOneProviderDataSchema,
  chaseProviderDataSchema,
  deltaProviderDataSchema,
  frontierProviderDataSchema,
  hiltonProviderDataSchema,
  hyattProviderDataSchema,
  ihgProviderDataSchema,
  marriottProviderDataSchema,
  southwestProviderDataSchema,
  unitedProviderDataSchema,
  discoverProviderDataSchema,
  citiProviderDataSchema,
} from "../contracts/loyalty-provider-data";
import { orderedProviderIds } from "../providers/provider-groups";

export interface PopupOnboardingFlags {
  disclosureAccepted: boolean;
  consentGiven: boolean;
  firstSyncCompleted: boolean;
}

export interface PopupSnapshot {
  auth: NextCardAuth | null;
  allStates: ProviderStateMap;
}

function emptyProviderState<T>(): ProviderSyncState<T> {
  return {
    status: "idle",
    data: null,
    error: null,
    lastSyncedAt: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSyncStatus(value: unknown): value is SyncStatus {
  return (
    value === "idle"
    || value === "detecting_login"
    || value === "waiting_for_login"
    || value === "extracting"
    || value === "done"
    || value === "cancelled"
    || value === "error"
  );
}

function normalizeProviderState<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  value: unknown,
): ProviderSyncState<T> {
  if (!isRecord(value)) {
    return emptyProviderState<T>();
  }

  const status = isSyncStatus(value.status)
    ? value.status
    : "idle";
  const error = typeof value.error === "string" ? value.error : null;
  const lastSyncedAt =
    typeof value.lastSyncedAt === "string" ? value.lastSyncedAt : null;

  const parsed = "data" in value ? schema.safeParse(value.data) : { success: false as const };

  return {
    status,
    data: parsed.success ? parsed.data : null,
    error,
    lastSyncedAt,
  };
}

function normalizeAuth(value: unknown): NextCardAuth | null {
  if (!isRecord(value) || typeof value.token !== "string") {
    return null;
  }

  return {
    token: value.token,
    name: typeof value.name === "string" ? value.name : null,
    email: typeof value.email === "string" ? value.email : null,
    signedInAt:
      typeof value.signedInAt === "string" ? value.signedInAt : new Date().toISOString(),
  };
}

export function normalizeOnboardingFlags(record: Record<string, unknown>): PopupOnboardingFlags {
  return {
    disclosureAccepted: Boolean(record.disclosureAccepted),
    consentGiven: Boolean(record.consentGiven),
    firstSyncCompleted: Boolean(record.firstSyncCompleted),
  };
}

export function hydrateStoredProviderStates(record: Record<string, unknown>): ProviderStateMap {
  return {
    marriott: normalizeProviderState(
      marriottProviderDataSchema,
      record.provider_marriott,
    ),
    atmos: normalizeProviderState(atmosProviderDataSchema, record.provider_atmos),
    chase: normalizeProviderState(chaseProviderDataSchema, record.provider_chase),
    aa: normalizeProviderState(aaProviderDataSchema, record.provider_aa),
    delta: normalizeProviderState(deltaProviderDataSchema, record.provider_delta),
    united: normalizeProviderState(unitedProviderDataSchema, record.provider_united),
    southwest: normalizeProviderState(
      southwestProviderDataSchema,
      record.provider_southwest,
    ),
    ihg: normalizeProviderState(ihgProviderDataSchema, record.provider_ihg),
    hyatt: normalizeProviderState(hyattProviderDataSchema, record.provider_hyatt),
    amex: normalizeProviderState(amexProviderDataSchema, record.provider_amex),
    capitalone: normalizeProviderState(
      capitalOneProviderDataSchema,
      record.provider_capitalone,
    ),
    hilton: normalizeProviderState(hiltonProviderDataSchema, record.provider_hilton),
    frontier: normalizeProviderState(
      frontierProviderDataSchema,
      record.provider_frontier,
    ),
    bilt: normalizeProviderState(biltProviderDataSchema, record.provider_bilt),
    discover: normalizeProviderState(discoverProviderDataSchema, record.provider_discover),
    citi: normalizeProviderState(citiProviderDataSchema, record.provider_citi),
  };
}

export async function loadOnboardingFlags() {
  const result = await chrome.storage.local.get([
    "disclosureAccepted",
    "consentGiven",
    "firstSyncCompleted",
  ]);

  return normalizeOnboardingFlags(result);
}

export function subscribeToOnboardingFlags(
  onChange: (flags: Partial<PopupOnboardingFlags>) => void,
) {
  const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (
    changes,
  ) => {
    const patch: Partial<PopupOnboardingFlags> = {};
    if (changes.disclosureAccepted) {
      patch.disclosureAccepted = Boolean(changes.disclosureAccepted.newValue);
    }
    if (changes.consentGiven) {
      patch.consentGiven = Boolean(changes.consentGiven.newValue);
    }
    if (changes.firstSyncCompleted) {
      patch.firstSyncCompleted = Boolean(changes.firstSyncCompleted.newValue);
    }
    onChange(patch);
  };

  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export async function loadStoredProviderStates() {
  const storageKeys = orderedProviderIds.map((providerId) => `provider_${providerId}`);
  const result = await chrome.storage.local.get(storageKeys);
  return hydrateStoredProviderStates(result);
}

export async function getAuthState() {
  const auth = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  return normalizeAuth(auth);
}

export async function loadInitialPopupState(): Promise<PopupSnapshot> {
  const [auth, allStates] = await Promise.all([
    getAuthState(),
    loadStoredProviderStates(),
  ]);

  return { auth, allStates };
}

export async function pollPopupSnapshot() {
  const auth = await getAuthState();
  if (!auth) {
    return { auth, allStates: null };
  }

  const liveStates = await chrome.runtime.sendMessage({ type: "GET_ALL_STATUS" });
  const record = isRecord(liveStates) ? liveStates : {};
  const allStates = {
    marriott: normalizeProviderState(marriottProviderDataSchema, record.marriott),
    atmos: normalizeProviderState(atmosProviderDataSchema, record.atmos),
    chase: normalizeProviderState(chaseProviderDataSchema, record.chase),
    aa: normalizeProviderState(aaProviderDataSchema, record.aa),
    delta: normalizeProviderState(deltaProviderDataSchema, record.delta),
    united: normalizeProviderState(unitedProviderDataSchema, record.united),
    southwest: normalizeProviderState(southwestProviderDataSchema, record.southwest),
    ihg: normalizeProviderState(ihgProviderDataSchema, record.ihg),
    hyatt: normalizeProviderState(hyattProviderDataSchema, record.hyatt),
    amex: normalizeProviderState(amexProviderDataSchema, record.amex),
    capitalone: normalizeProviderState(capitalOneProviderDataSchema, record.capitalone),
    hilton: normalizeProviderState(hiltonProviderDataSchema, record.hilton),
    frontier: normalizeProviderState(frontierProviderDataSchema, record.frontier),
    bilt: normalizeProviderState(biltProviderDataSchema, record.bilt),
    discover: normalizeProviderState(discoverProviderDataSchema, record.discover),
    citi: normalizeProviderState(citiProviderDataSchema, record.citi),
  };
  return { auth, allStates };
}

export function startProviderSync(providerId: ProviderId) {
  return new Promise<boolean>((resolve) => {
    chrome.runtime.sendMessage(
      { type: "REQUEST_SYNC", provider: providerId },
      (response: { ok?: boolean; error?: string } | undefined) => {
        if (chrome.runtime.lastError) {
          console.error(
            `[NextCard Popup] Failed to start ${providerId} sync:`,
            chrome.runtime.lastError.message,
          );
          resolve(false);
          return;
        }

        if (response?.ok === false) {
          console.error(
            `[NextCard Popup] ${providerId} sync rejected:`,
            response.error ?? "Unknown error",
          );
          resolve(false);
          return;
        }

        resolve(true);
      },
    );
  });
}
