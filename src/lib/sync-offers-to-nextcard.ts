/**
 * Syncs enrolled merchant offers from the extension to the NextCard backend.
 *
 * Flow: extension → HTTP POST to Convex httpAction → upsert userMerchantOffers
 *
 * Retry logic: on transient failure, retries up to 2 times with 2s delay.
 * If all retries fail, persists the payload to chrome.storage.local for
 * retry on next extension startup.
 */

import { getAuth, getAuthGeneration } from "./auth";
import {
  getCurrentHouseholdOperationScope,
  getHouseholdScopedStorageKey,
  householdOperationScopesMatch,
  isLegacyHouseholdOperationMode,
  type HouseholdOperationScope,
} from "./household-context";

function readOfferSyncError(value: unknown, status: number) {
  if (typeof value === "object" && value !== null) {
    if ("code" in value && typeof value.code === "string") return value.code;
    if ("error" in value && typeof value.error === "string") return value.error;
  }
  return `HTTP ${status}`;
}

function isTerminalOfferScopeError(error: string | null | undefined) {
  return error === "stale_offer_operation"
    || error === "context_stale"
    || error === "member_unavailable"
    || error === "member_gone"
    || error === "household_capability_disabled"
    || error === "extension_writes_disabled"
    || error === "extension_reads_disabled"
    || error === "member_offer_writes_disabled"
    || error === "unsupported_extension"
    || error === "invalid_request";
}

async function getIssuerCardKey(issuer: string, issuerCardId: string): Promise<string> {
  if (!issuerCardId) return "";

  const payload = new TextEncoder().encode(
    `nextcard:issuer-card:v1:${issuer.trim().toLowerCase()}:${issuerCardId}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const value = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `v1:${value}`;
}

function getLegacyIssuerCardId(issuerCardId: string): string {
  const suffix = issuerCardId.replace(/\D/g, "").slice(-4);
  return suffix ? `****${suffix}` : "";
}

export interface OfferSyncPayload {
  runId?: string;
  scope: HouseholdOperationScope | null;
  issuer: string;
  issuerCardId: string;
  issuerCardName: string;
  issuerCardLastDigits: string | null;
  offers: Array<{
    issuerOfferId: string;
    merchantName: string;
    offerValue: string | null;
    category: string | null;
    expirationDate: string | null;
    rewardType: "percentage" | "flat_cash" | "points" | null;
    rewardAmount: number | null;
    rewardCurrency: string | null;
    maxReward: number | null;
    minSpend: number | null;
    merchantUrl: string | null;
    merchantLogoUrl: string | null;
    redemptionChannel: "online" | "in_store" | "both" | null;
    enrolledAt: string;
  }>;
}

export type MerchantOfferSyncStatus = "enrolled" | "detected";

export interface CompleteOfferSnapshot {
  complete: true;
  capturedAt: string;
  observedIssuerOfferIds: string[];
}

export interface CachedOffer {
  merchantName: string;
  offerValue: string | null;
  cardName: string;
  cardLastDigits: string | null;
  expirationDate: string | null;
  issuer: string;
  rewardType: "percentage" | "flat_cash" | "points" | null;
  rewardAmount: number | null;
  status?: MerchantOfferSyncStatus;
}

export type OfferUrlCache = Record<string, CachedOffer[]>;

export const OFFER_URL_CACHE_KEY = "offerUrlCache";
export const DETECTED_OFFER_URL_CACHE_KEY = "detectedOfferUrlCache";

export interface DetectedOfferSyncPayload {
  runId?: string;
  scope: HouseholdOperationScope | null;
  issuer: string;
  issuerCardId: string;
  issuerCardName: string;
  issuerCardLastDigits: string | null;
  // Present only after the issuer returned every page for this card. The
  // backend must not use partial responses to mark offers unavailable.
  snapshot?: CompleteOfferSnapshot;
  offers: Array<{
    issuerOfferId: string;
    merchantName: string;
    offerValue: string | null;
    category: string | null;
    expirationDate: string | null;
    rewardType: "percentage" | "flat_cash" | "points" | null;
    rewardAmount: number | null;
    rewardCurrency: string | null;
    maxReward: number | null;
    minSpend: number | null;
    merchantUrl: string | null;
    merchantLogoUrl: string | null;
    redemptionChannel: "online" | "in_store" | "both" | null;
    status?: MerchantOfferSyncStatus;
    detectedAt: string;
  }>;
}

function offerSyncScopeMatches(
  payloadScope: HouseholdOperationScope | null | undefined,
  currentScope: HouseholdOperationScope | null,
) {
  if (!payloadScope || !currentScope) return payloadScope == null && currentScope == null;
  return householdOperationScopesMatch(payloadScope, currentScope);
}

async function offerSyncScopeIsCurrent(
  scope: HouseholdOperationScope | null,
) {
  const generation = getAuthGeneration();
  if (!await getAuth()) return false;
  const currentScope = await getCurrentHouseholdOperationScope();
  const matches = scope === null
    ? currentScope === null && await isLegacyHouseholdOperationMode()
    : currentScope !== null
      && householdOperationScopesMatch(scope, currentScope);
  return generation === getAuthGeneration() && matches;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const STORAGE_KEY = "pendingOfferSyncs";
const DETECTED_STORAGE_KEY = "pendingDetectedOfferSyncs";

function hasOptionalRunId(value: unknown): value is { runId?: unknown } {
  return typeof value === "object" && value !== null;
}
// Detected-offer upserts can require a substantial read of the user's offer
// history. Keep each request well below Convex's per-function read limit.
const DETECTED_OFFER_SYNC_CHUNK_SIZE = 50;
let detectedOfferSyncQueue: Promise<void> = Promise.resolve();
let enrolledOfferSyncQueue: Promise<void> = Promise.resolve();

function enqueueEnrolledOfferTask<T>(task: () => Promise<T>): Promise<T> {
  const queued = enrolledOfferSyncQueue.then(task, task);
  enrolledOfferSyncQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

function enqueueDetectedOfferTask<T>(task: () => Promise<T>): Promise<T> {
  const queued = detectedOfferSyncQueue.then(task, task);
  detectedOfferSyncQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function storageValuesEqual(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

async function removeStorageValuesIfUnchanged(
  expected: Record<string, unknown>,
) {
  const keys = Object.keys(expected);
  const stored = await chrome.storage.local.get(keys);
  const unchangedKeys = keys.filter((key) =>
    storageValuesEqual(stored[key], expected[key])
  );
  if (unchangedKeys.length > 0) {
    await chrome.storage.local.remove(unchangedKeys);
  }
}

export function normalizeHostname(urlOrHostname: string): string | null {
  try {
    let hostname: string;
    if (urlOrHostname.includes("://")) {
      hostname = new URL(urlOrHostname).hostname;
    } else {
      hostname = urlOrHostname;
    }
    return hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function splitOfferMapByStatus(offerMap: OfferUrlCache): { enrolled: OfferUrlCache; detected: OfferUrlCache } {
  const enrolled: OfferUrlCache = {};
  const detected: OfferUrlCache = {};

  for (const [host, offers] of Object.entries(offerMap)) {
    const normalizedHost = normalizeHostname(host);
    if (!normalizedHost) continue;

    for (const offer of offers) {
      const target = offer.status === "detected" ? detected : enrolled;
      if (!target[normalizedHost]) target[normalizedHost] = [];
      target[normalizedHost].push(offer);
    }
  }

  return { enrolled, detected };
}

async function saveOfferMaps(
  offerMap: OfferUrlCache,
  scope: HouseholdOperationScope | null,
): Promise<void> {
  if (!await offerSyncScopeIsCurrent(scope)) return;
  const generation = getAuthGeneration();
  const { enrolled, detected } = splitOfferMapByStatus(offerMap);
  const enrolledKey = getHouseholdScopedStorageKey(OFFER_URL_CACHE_KEY, scope);
  const detectedKey = getHouseholdScopedStorageKey(DETECTED_OFFER_URL_CACHE_KEY, scope);
  await chrome.storage.local.set({
    [enrolledKey]: enrolled,
    [detectedKey]: detected,
  });
  if (generation !== getAuthGeneration()) {
    await removeStorageValuesIfUnchanged({
      [enrolledKey]: enrolled,
      [detectedKey]: detected,
    });
  }
}

async function updateOfferUrlCache(payload: OfferSyncPayload): Promise<void> {
  try {
    if (!await offerSyncScopeIsCurrent(payload.scope)) return;
    const generation = getAuthGeneration();
    const storageKey = getHouseholdScopedStorageKey(
      OFFER_URL_CACHE_KEY,
      payload.scope,
    );
    const stored = await chrome.storage.local.get(storageKey);
    const cache: OfferUrlCache = stored[storageKey] ?? {};

    for (const offer of payload.offers) {
      if (!offer.merchantUrl) continue;

      const hostname = normalizeHostname(offer.merchantUrl);
      if (!hostname) continue;

      const entry: CachedOffer = {
        merchantName: offer.merchantName,
        offerValue: offer.offerValue,
        cardName: payload.issuerCardName,
        cardLastDigits: payload.issuerCardLastDigits,
        expirationDate: offer.expirationDate,
        issuer: payload.issuer,
        rewardType: offer.rewardType,
        rewardAmount: offer.rewardAmount,
        status: "enrolled",
      };

      if (!cache[hostname]) {
        cache[hostname] = [entry];
      } else {
        // Dedupe by issuer + card + merchant
        const isDupe = cache[hostname].some(
          (e) =>
            e.issuer === entry.issuer &&
            e.cardLastDigits === entry.cardLastDigits &&
            e.merchantName === entry.merchantName,
        );
        if (!isDupe) {
          cache[hostname].push(entry);
        }
      }
    }

    if (generation !== getAuthGeneration()) return;
    await chrome.storage.local.set({ [storageKey]: cache });
    if (generation !== getAuthGeneration()) {
      await removeStorageValuesIfUnchanged({ [storageKey]: cache });
    }
  } catch (e) {
    console.error("[NextCard Offers] Failed to update offer URL cache:", e);
  }
}

async function postOfferSync(
  payload: OfferSyncPayload,
): Promise<{ ok: boolean; error?: string; offerMap?: OfferUrlCache }> {
  const auth = await getAuth();
  if (!auth) {
    return { ok: false, error: "Not signed in to NextCard" };
  }
  if (!await offerSyncScopeIsCurrent(payload.scope)) {
    return { ok: false, error: "stale_offer_operation" };
  }
  const issuerCardKey = await getIssuerCardKey(payload.issuer, payload.issuerCardId);
  if (!issuerCardKey) {
    return { ok: false, error: "Missing issuer card identity" };
  }
  const { scope: localScope, ...wirePayload } = payload;
  void localScope;

  const endpoint = payload.scope
    ? `${__CONVEX_SITE_URL__}/extension/v2/offers-sync`
    : `${__CONVEX_SITE_URL__}/extension/offers-sync`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
      ...(payload.scope
        ? {
            "X-Nextcard-Extension-Version": chrome.runtime.getManifest().version,
            "X-Nextcard-Protocol-Version": "2",
          }
        : {}),
    },
    body: JSON.stringify({
      ...wirePayload,
      ...(payload.scope
        ? {
            memberId: payload.scope.memberId,
            contextRevision: payload.scope.contextRevision,
            memberLifecycleVersion: payload.scope.memberLifecycleVersion,
          }
        : {}),
      issuerCardId: issuerCardKey,
      legacyIssuerCardId: getLegacyIssuerCardId(payload.issuerCardId),
    }),
  });

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    return { ok: false, error: readOfferSyncError(result, response.status) };
  }

  const body = await response.json().catch(() => ({}));
  const debug = (body as Record<string, unknown>).debug;
  if (debug) {
    console.info("[NextCard Offers Sync] summary:", debug);
  }
  return { ok: true, offerMap: (body as Record<string, unknown>).offerMap as OfferUrlCache | undefined };
}

async function persistForRetry(payload: OfferSyncPayload): Promise<boolean> {
  return enqueueEnrolledOfferTask(async () => {
    try {
      const generation = getAuthGeneration();
      if (!await offerSyncScopeIsCurrent(payload.scope)) return false;
      const storageKey = getHouseholdScopedStorageKey(STORAGE_KEY, payload.scope);
      const stored = await chrome.storage.local.get(storageKey);
      const pending: OfferSyncPayload[] = stored[storageKey] ?? [];
      pending.push(payload);
      if (getAuthGeneration() !== generation) return false;
      await chrome.storage.local.set({ [storageKey]: pending });
      if (getAuthGeneration() !== generation) {
        await removeStorageValuesIfUnchanged({ [storageKey]: pending });
        return false;
      }
      return true;
    } catch (e) {
      console.error("[NextCard Offers Sync] Failed to persist for retry:", e);
      return false;
    }
  });
}

async function persistDetectedForRetry(payload: DetectedOfferSyncPayload): Promise<boolean> {
  try {
    const generation = getAuthGeneration();
    if (!await offerSyncScopeIsCurrent(payload.scope)) return false;
    const storageKey = getHouseholdScopedStorageKey(
      DETECTED_STORAGE_KEY,
      payload.scope,
    );
    const stored = await chrome.storage.local.get(storageKey);
    const pending: DetectedOfferSyncPayload[] = stored[storageKey] ?? [];
    const payloadKey = [
      payload.runId ?? "",
      payload.issuer,
      payload.issuerCardId,
      payload.snapshot?.capturedAt ?? "",
    ].join(":");
    const deduplicated = pending.filter((entry) => [
      entry.runId ?? "",
      entry.issuer,
      entry.issuerCardId,
      entry.snapshot?.capturedAt ?? "",
    ].join(":") !== payloadKey);
    if (getAuthGeneration() !== generation) return false;
    const nextPending = [...deduplicated, payload];
    await chrome.storage.local.set({ [storageKey]: nextPending });
    if (getAuthGeneration() !== generation) {
      await removeStorageValuesIfUnchanged({ [storageKey]: nextPending });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[NextCard Detected Offers] Failed to persist for retry:", error);
    return false;
  }
}

/** Backfill fields that may be missing from stale persisted payloads. */
function normalizeOffers(payload: OfferSyncPayload): OfferSyncPayload {
  return {
    ...payload,
    offers: payload.offers.map((o) => ({
      issuerOfferId: o.issuerOfferId,
      merchantName: o.merchantName,
      offerValue: o.offerValue ?? null,
      category: o.category ?? null,
      expirationDate: o.expirationDate ?? null,
      rewardType: o.rewardType ?? null,
      rewardAmount: o.rewardAmount ?? null,
      rewardCurrency: o.rewardCurrency ?? null,
      maxReward: o.maxReward ?? null,
      minSpend: o.minSpend ?? null,
      merchantUrl: o.merchantUrl ?? null,
      merchantLogoUrl: o.merchantLogoUrl ?? null,
      redemptionChannel: o.redemptionChannel ?? null,
      enrolledAt: o.enrolledAt,
    })),
  };
}

export type OfferSyncStatus = "saved" | "queued_for_retry" | "failed";

export interface OfferSyncResult {
  status: OfferSyncStatus;
  error: string | null;
}

interface PendingOfferSyncRetryResult {
  savedRunIds: string[];
  remainingRunIds: string[];
  failedRunIds: string[];
}

function buildPendingOfferSyncRetryResult(
  savedRunIds: string[],
  remainingRunIds: string[],
  failedRunIds: string[] = [],
): PendingOfferSyncRetryResult {
  const failed = new Set(failedRunIds);
  const remaining = new Set(
    remainingRunIds.filter((runId) => !failed.has(runId)),
  );
  return {
    savedRunIds: Array.from(new Set(savedRunIds)).filter(
      (runId) => !remaining.has(runId) && !failed.has(runId),
    ),
    remainingRunIds: Array.from(remaining),
    failedRunIds: Array.from(failed),
  };
}

export async function syncOffersToNextCard(payload: OfferSyncPayload): Promise<OfferSyncResult> {
  if (payload.offers.length === 0) return { status: "saved", error: null };

  payload = normalizeOffers(payload);
  let lastError = "nextcard did not accept the offer update";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await postOfferSync(payload);
      if (result.ok) {
        if (!await offerSyncScopeIsCurrent(payload.scope)) {
          return { status: "saved", error: null };
        }
        if (result.offerMap) {
          try {
            await saveOfferMaps(result.offerMap, payload.scope);
          } catch (error) {
            // The remote write already succeeded. A local reminder-cache
            // failure must not turn that successful write into a sync failure.
            console.warn(
              "[NextCard Offers Sync] Saved remotely; local offer cache will refresh later:",
              error,
            );
          }
        } else {
          await updateOfferUrlCache(payload);
        }
        return { status: "saved", error: null };
      }
      lastError = result.error ?? lastError;

      if (isTerminalOfferScopeError(result.error)) {
        return { status: "failed", error: lastError };
      }

      // Auth errors won't resolve with retry
      if (result.error?.includes("token") || result.error?.includes("401")) {
        console.warn(`[NextCard Offers Sync] Auth error, skipping retry: ${result.error}`);
        const queued = await persistForRetry(payload);
        return queued
          ? { status: "queued_for_retry", error: lastError }
          : {
              status: "failed",
              error: "Couldn’t queue the nextcard save for retry. Reload the extension and try again.",
            };
      }

      console.warn(`[NextCard Offers Sync] Attempt ${attempt + 1} failed: ${result.error}`);
    } catch (e) {
      lastError = e instanceof Error ? e.message : "Unexpected nextcard sync error";
      console.warn(`[NextCard Offers Sync] Attempt ${attempt + 1} network error:`, e);
    }

    if (attempt < MAX_RETRIES) {
      await delay(RETRY_DELAY_MS);
    }
  }

  // All retries exhausted — persist for later
  const queued = await persistForRetry(payload);
  return queued
    ? { status: "queued_for_retry", error: lastError }
    : {
        status: "failed",
        error: "Couldn’t queue the nextcard save for retry. Reload the extension and try again.",
      };
}

/** Retry any pending syncs stored from previous failures. Call on startup. */
async function retryPendingEnrolledOfferSyncs(
  scope: HouseholdOperationScope | null,
): Promise<{
  savedRunIds: string[];
  remainingRunIds: string[];
  failedRunIds: string[];
}> {
  const savedRunIds: string[] = [];
  const failedRunIds: string[] = [];
  try {
    const storageKey = getHouseholdScopedStorageKey(STORAGE_KEY, scope);
    const stored = await chrome.storage.local.get(storageKey);
    const pending: OfferSyncPayload[] = stored[storageKey] ?? [];
    if (pending.length === 0) {
      return { savedRunIds, remainingRunIds: [], failedRunIds };
    }


    let remaining: OfferSyncPayload[] = [];
    for (const raw of pending) {
      const payload = normalizeOffers(raw);
      if (!offerSyncScopeMatches(payload.scope, scope)) {
        continue;
      }
      const result = await postOfferSync(payload);
      if (isTerminalOfferScopeError(result.error)) {
        if (payload.runId) failedRunIds.push(payload.runId);
        continue;
      }
      if (!result.ok) {
        remaining.push(payload);
      } else if (result.offerMap) {
        try {
          await saveOfferMaps(result.offerMap, payload.scope);
        } catch (error) {
          console.warn(
            "[NextCard Offers Sync] Retry saved remotely; local offer cache will refresh later:",
            error,
          );
        }
        if (payload.runId) savedRunIds.push(payload.runId);
      } else {
        await updateOfferUrlCache(payload);
        if (payload.runId) savedRunIds.push(payload.runId);
      }
    }

    const failed = new Set(failedRunIds);
    remaining = remaining.filter(
      (payload) => !payload.runId || !failed.has(payload.runId),
    );

    await chrome.storage.local.set({ [storageKey]: remaining });
    if (remaining.length > 0) {
      console.warn(`[NextCard Offers Sync] ${remaining.length} syncs still pending after retry`);
    }
    return buildPendingOfferSyncRetryResult(
      savedRunIds,
      remaining.flatMap((payload) => payload.runId ? [payload.runId] : []),
      failedRunIds,
    );
  } catch (e) {
    console.error("[NextCard Offers Sync] retryPendingOfferSyncs error:", e);
    return buildPendingOfferSyncRetryResult([], savedRunIds);
  }
}

async function postDetectedOfferSync(
  payload: DetectedOfferSyncPayload,
): Promise<{ ok: boolean; error: string | null }> {
  const auth = await getAuth();
  if (!auth) return { ok: false, error: "Not signed in to NextCard" };
  if (!await offerSyncScopeIsCurrent(payload.scope)) {
    return { ok: false, error: "stale_offer_operation" };
  }

  try {
    let latestOfferMap: OfferUrlCache | undefined;
    const issuerCardKey = await getIssuerCardKey(payload.issuer, payload.issuerCardId);
    if (!issuerCardKey) return { ok: false, error: "Missing issuer card identity" };
    const { scope: localScope, ...wirePayload } = payload;
    void localScope;
    const endpoint = payload.scope
      ? `${__CONVEX_SITE_URL__}/extension/v2/offers-detected`
      : `${__CONVEX_SITE_URL__}/extension/offers-detected`;
    const chunkOffsets = payload.offers.length === 0 ? [0] : Array.from(
      { length: Math.ceil(payload.offers.length / DETECTED_OFFER_SYNC_CHUNK_SIZE) },
      (_, index) => index * DETECTED_OFFER_SYNC_CHUNK_SIZE,
    );

    for (const offset of chunkOffsets) {
      const offers = payload.offers.slice(offset, offset + DETECTED_OFFER_SYNC_CHUNK_SIZE);
      const isLastChunk = offset + DETECTED_OFFER_SYNC_CHUNK_SIZE >= payload.offers.length;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
          ...(payload.scope
            ? {
                "X-Nextcard-Extension-Version": chrome.runtime.getManifest().version,
                "X-Nextcard-Protocol-Version": "2",
              }
            : {}),
        },
        body: JSON.stringify({
          ...wirePayload,
          ...(payload.scope
            ? {
                memberId: payload.scope.memberId,
                contextRevision: payload.scope.contextRevision,
                memberLifecycleVersion: payload.scope.memberLifecycleVersion,
              }
            : {}),
          issuerCardId: issuerCardKey,
          legacyIssuerCardId: getLegacyIssuerCardId(payload.issuerCardId),
          offers,
          // The full URL map can exceed Convex's read limit for users with a
          // large offer history. Detected offers are still persisted; the map
          // is refreshed separately on extension startup.
          skipOfferMap: true,
          snapshot: payload.snapshot,
          reconcileSnapshot: isLastChunk && payload.snapshot?.complete === true,
        }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        const error = readOfferSyncError(result, response.status);
        console.warn("[NextCard Detected Offers] chunk sync failed:", {
          status: response.status,
          error,
          offset,
          count: offers.length,
        });
        return { ok: false, error };
      }

      const body = await response.json().catch(() => ({}));
      const debug = (body as Record<string, unknown>).debug;
      if (debug) {
        console.info("[NextCard Detected Offers] chunk summary:", {
          offset,
          count: offers.length,
          debug,
        });
      }
      latestOfferMap = (body as Record<string, unknown>).offerMap as OfferUrlCache | undefined;
    }

    if (latestOfferMap && await offerSyncScopeIsCurrent(payload.scope)) {
      await saveOfferMaps(latestOfferMap, payload.scope);
    }
    return { ok: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected nextcard sync error";
    console.warn("[NextCard Detected Offers] sync error:", error);
    return { ok: false, error: message };
  }
}

async function runDetectedOfferSync(
  payload: DetectedOfferSyncPayload,
): Promise<OfferSyncStatus> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const result = await postDetectedOfferSync(payload);
    if (result.ok) return "saved";

    const isAuthFailure = result.error?.includes("token")
      || result.error?.includes("401")
      || result.error === "Not signed in to NextCard";
    if (isTerminalOfferScopeError(result.error)) return "failed";
    if (isAuthFailure) break;
    if (attempt < MAX_RETRIES) await delay(RETRY_DELAY_MS);
  }

  return await persistDetectedForRetry(payload) ? "queued_for_retry" : "failed";
}

/**
 * Serialize detected-offer saves so multi-card Amex runs cannot contend with
 * each other, then durably queue any payload that still fails after retries.
 */
export function syncDetectedOffersToNextCard(
  payload: DetectedOfferSyncPayload,
): Promise<OfferSyncStatus> {
  return enqueueDetectedOfferTask(() => runDetectedOfferSync(payload));
}

async function runPendingDetectedOfferSyncs(
  scope: HouseholdOperationScope | null,
): Promise<{
  savedRunIds: string[];
  remainingRunIds: string[];
  failedRunIds: string[];
}> {
  const savedRunIds: string[] = [];
  const failedRunIds: string[] = [];
  try {
    const storageKey = getHouseholdScopedStorageKey(DETECTED_STORAGE_KEY, scope);
    const stored = await chrome.storage.local.get(storageKey);
    const pending: DetectedOfferSyncPayload[] = stored[storageKey] ?? [];
    let remaining: DetectedOfferSyncPayload[] = [];

    for (const payload of pending) {
      if (!offerSyncScopeMatches(payload.scope, scope)) {
        continue;
      }
      const result = await postDetectedOfferSync(payload);
      if (result.ok) {
        if (payload.runId) savedRunIds.push(payload.runId);
      } else if (!isTerminalOfferScopeError(result.error)) {
        remaining.push(payload);
      } else if (payload.runId) {
        failedRunIds.push(payload.runId);
      }
    }

    const failed = new Set(failedRunIds);
    remaining = remaining.filter(
      (payload) => !payload.runId || !failed.has(payload.runId),
    );

    await chrome.storage.local.set({ [storageKey]: remaining });
    return buildPendingOfferSyncRetryResult(
      savedRunIds,
      remaining.flatMap((payload) => payload.runId ? [payload.runId] : []),
      failedRunIds,
    );
  } catch (error) {
    console.error("[NextCard Detected Offers] retryPendingDetectedOfferSyncs error:", error);
    return buildPendingOfferSyncRetryResult([], savedRunIds);
  }
}

export function retryPendingDetectedOfferSyncs(
  scope: HouseholdOperationScope | null = null,
): Promise<{
  savedRunIds: string[];
  remainingRunIds: string[];
  failedRunIds: string[];
}> {
  return enqueueDetectedOfferTask(() => runPendingDetectedOfferSyncs(scope));
}

export async function retryPendingOfferSyncs(
  scope: HouseholdOperationScope | null = null,
): Promise<{
  savedRunIds: string[];
  remainingRunIds: string[];
  failedRunIds: string[];
}> {
  const [enrolledResult, detectedResult] = await Promise.all([
    enqueueEnrolledOfferTask(() => retryPendingEnrolledOfferSyncs(scope)),
    retryPendingDetectedOfferSyncs(scope),
  ]);
  const failedRunIds = Array.from(new Set([
    ...enrolledResult.failedRunIds,
    ...detectedResult.failedRunIds,
  ]));
  if (failedRunIds.length > 0) {
    const failed = new Set(failedRunIds);
    const removeFailedRuns = async (storageKey: string) => {
      const stored = await chrome.storage.local.get(storageKey);
      const pending = Array.isArray(stored[storageKey])
        ? stored[storageKey].filter(hasOptionalRunId)
        : [];
      const remaining = pending.filter((payload) =>
        typeof payload.runId !== "string" || !failed.has(payload.runId)
      );
      if (remaining.length !== pending.length) {
        await chrome.storage.local.set({ [storageKey]: remaining });
      }
    };
    await Promise.all([
      enqueueEnrolledOfferTask(() => removeFailedRuns(
        getHouseholdScopedStorageKey(STORAGE_KEY, scope),
      )),
      enqueueDetectedOfferTask(() => removeFailedRuns(
        getHouseholdScopedStorageKey(DETECTED_STORAGE_KEY, scope),
      )),
    ]);
  }
  return buildPendingOfferSyncRetryResult(
    [
      ...enrolledResult.savedRunIds,
      ...detectedResult.savedRunIds,
    ],
    [
      ...enrolledResult.remainingRunIds,
      ...detectedResult.remainingRunIds,
    ],
    failedRunIds,
  );
}

/** Pull offers from backend and rebuild both URL caches. Call on startup/re-auth. */
export async function pullOfferUrlCache(
  scope: HouseholdOperationScope | null = null,
): Promise<void> {
  try {
    const generation = getAuthGeneration();
    const auth = await getAuth();
    if (!auth) return;
    if (!await offerSyncScopeIsCurrent(scope)) return;

    const endpoint = scope
      ? `${__CONVEX_SITE_URL__}/extension/v2/offers-pull?${new URLSearchParams({
          memberId: scope.memberId,
          contextRevision: scope.contextRevision,
          memberLifecycleVersion: String(scope.memberLifecycleVersion),
        }).toString()}`
      : `${__CONVEX_SITE_URL__}/extension/offers-pull`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(scope
          ? {
              "X-Nextcard-Extension-Version": chrome.runtime.getManifest().version,
              "X-Nextcard-Protocol-Version": "2",
            }
          : {}),
      },
    });

    if (!response.ok) return;

    const data = await response.json();
    const offers: Array<{
      merchantName: string;
      merchantUrl: string | null;
      offerValue: string | null;
      issuer: string;
      cardName: string;
      cardLastDigits: string | null;
      expirationDate: string | null;
      rewardType: "percentage" | "flat_cash" | "points" | null;
      rewardAmount: number | null;
      status?: MerchantOfferSyncStatus;
    }> = data.offers ?? [];

    const enrolledCache: OfferUrlCache = {};
    const detectedCache: OfferUrlCache = {};

    for (const offer of offers) {
      if (!offer.merchantUrl) continue;
      const host = normalizeHostname(offer.merchantUrl);
      if (!host) continue;

      const entry: CachedOffer = {
        merchantName: offer.merchantName,
        offerValue: offer.offerValue,
        cardName: offer.cardName,
        cardLastDigits: offer.cardLastDigits,
        expirationDate: offer.expirationDate,
        issuer: offer.issuer,
        rewardType: offer.rewardType,
        rewardAmount: offer.rewardAmount,
        status: offer.status,
      };

      const target = offer.status === "detected" ? detectedCache : enrolledCache;
      if (!target[host]) {
        target[host] = [entry];
      } else {
        target[host].push(entry);
      }
    }

    if (!await offerSyncScopeIsCurrent(scope)) return;

    const enrolledKey = getHouseholdScopedStorageKey(OFFER_URL_CACHE_KEY, scope);
    const detectedKey = getHouseholdScopedStorageKey(DETECTED_OFFER_URL_CACHE_KEY, scope);
    if (generation !== getAuthGeneration()) return;
    await chrome.storage.local.set({
      [enrolledKey]: enrolledCache,
      [detectedKey]: detectedCache,
    });
    if (generation !== getAuthGeneration()) {
      await removeStorageValuesIfUnchanged({
        [enrolledKey]: enrolledCache,
        [detectedKey]: detectedCache,
      });
    }
  } catch (e) {
    console.error("[NextCard Offers] pullOfferUrlCache error:", e);
  }
}
