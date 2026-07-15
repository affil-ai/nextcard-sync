/**
 * Syncs enrolled merchant offers from the extension to the NextCard backend.
 *
 * Flow: extension → HTTP POST to Convex httpAction → upsert userMerchantOffers
 *
 * Retry logic: on transient failure, retries up to 2 times with 2s delay.
 * If all retries fail, persists the payload to chrome.storage.local for
 * retry on next extension startup.
 */

import { getAuth } from "./auth";

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

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const STORAGE_KEY = "pendingOfferSyncs";
const DETECTED_OFFER_SYNC_CHUNK_SIZE = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

async function saveOfferMaps(offerMap: OfferUrlCache): Promise<void> {
  const { enrolled, detected } = splitOfferMapByStatus(offerMap);
  await chrome.storage.local.set({
    [OFFER_URL_CACHE_KEY]: enrolled,
    [DETECTED_OFFER_URL_CACHE_KEY]: detected,
  });
}

async function updateOfferUrlCache(payload: OfferSyncPayload): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(OFFER_URL_CACHE_KEY);
    const cache: OfferUrlCache = stored[OFFER_URL_CACHE_KEY] ?? {};

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

    await chrome.storage.local.set({ [OFFER_URL_CACHE_KEY]: cache });
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
  const issuerCardKey = await getIssuerCardKey(payload.issuer, payload.issuerCardId);
  if (!issuerCardKey) {
    return { ok: false, error: "Missing issuer card identity" };
  }

  const response = await fetch(`${__CONVEX_SITE_URL__}/extension/offers-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify({
      ...payload,
      issuerCardId: issuerCardKey,
      legacyIssuerCardId: getLegacyIssuerCardId(payload.issuerCardId),
    }),
  });

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    return { ok: false, error: (result as Record<string, string>).error ?? `HTTP ${response.status}` };
  }

  const body = await response.json().catch(() => ({}));
  const debug = (body as Record<string, unknown>).debug;
  if (debug) {
    console.info("[NextCard Offers Sync] summary:", debug);
  }
  return { ok: true, offerMap: (body as Record<string, unknown>).offerMap as OfferUrlCache | undefined };
}

async function persistForRetry(payload: OfferSyncPayload): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const pending: OfferSyncPayload[] = stored[STORAGE_KEY] ?? [];
    pending.push(payload);
    await chrome.storage.local.set({ [STORAGE_KEY]: pending });
    return true;
  } catch (e) {
    console.error("[NextCard Offers Sync] Failed to persist for retry:", e);
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

export async function syncOffersToNextCard(payload: OfferSyncPayload): Promise<boolean> {
  if (payload.offers.length === 0) return true;

  payload = normalizeOffers(payload);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await postOfferSync(payload);
      if (result.ok) {
        if (result.offerMap) {
          await saveOfferMaps(result.offerMap);
        } else {
          await updateOfferUrlCache(payload);
        }
        return true;
      }

      // Auth errors won't resolve with retry
      if (result.error?.includes("token") || result.error?.includes("401")) {
        console.warn(`[NextCard Offers Sync] Auth error, skipping retry: ${result.error}`);
        return persistForRetry(payload);
      }

      console.warn(`[NextCard Offers Sync] Attempt ${attempt + 1} failed: ${result.error}`);
    } catch (e) {
      console.warn(`[NextCard Offers Sync] Attempt ${attempt + 1} network error:`, e);
    }

    if (attempt < MAX_RETRIES) {
      await delay(RETRY_DELAY_MS);
    }
  }

  // All retries exhausted — persist for later
  return persistForRetry(payload);
}

/** Retry any pending syncs stored from previous failures. Call on startup. */
export async function retryPendingOfferSyncs(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const pending: OfferSyncPayload[] = stored[STORAGE_KEY] ?? [];
    if (pending.length === 0) return;


    const remaining: OfferSyncPayload[] = [];
    for (const raw of pending) {
      const payload = normalizeOffers(raw);
      const result = await postOfferSync(payload);
      if (!result.ok) {
        remaining.push(payload);
      } else if (result.offerMap) {
        await saveOfferMaps(result.offerMap);
      } else {
        await updateOfferUrlCache(payload);
      }
    }

    await chrome.storage.local.set({ [STORAGE_KEY]: remaining });
    if (remaining.length > 0) {
      console.warn(`[NextCard Offers Sync] ${remaining.length} syncs still pending after retry`);
    }
  } catch (e) {
    console.error("[NextCard Offers Sync] retryPendingOfferSyncs error:", e);
  }
}

export async function syncDetectedOffersToNextCard(payload: DetectedOfferSyncPayload): Promise<void> {
  const auth = await getAuth();
  if (!auth) return;

  try {
    let latestOfferMap: OfferUrlCache | undefined;
    const issuerCardKey = await getIssuerCardKey(payload.issuer, payload.issuerCardId);
    if (!issuerCardKey) return;
    const chunkOffsets = payload.offers.length === 0 ? [0] : Array.from(
      { length: Math.ceil(payload.offers.length / DETECTED_OFFER_SYNC_CHUNK_SIZE) },
      (_, index) => index * DETECTED_OFFER_SYNC_CHUNK_SIZE,
    );

    for (const offset of chunkOffsets) {
      const offers = payload.offers.slice(offset, offset + DETECTED_OFFER_SYNC_CHUNK_SIZE);
      const isLastChunk = offset + DETECTED_OFFER_SYNC_CHUNK_SIZE >= payload.offers.length;
      const response = await fetch(`${__CONVEX_SITE_URL__}/extension/offers-detected`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({
          ...payload,
          issuerCardId: issuerCardKey,
          legacyIssuerCardId: getLegacyIssuerCardId(payload.issuerCardId),
          offers,
          skipOfferMap: !isLastChunk,
          snapshot: payload.snapshot,
          reconcileSnapshot: isLastChunk && payload.snapshot?.complete === true,
        }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        console.warn("[NextCard Detected Offers] chunk sync failed:", {
          status: response.status,
          error: (result as Record<string, string>).error,
          offset,
          count: offers.length,
        });
        return;
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

    if (latestOfferMap) {
      await saveOfferMaps(latestOfferMap);
    }
  } catch (e) {
    console.warn("[NextCard Detected Offers] sync error:", e);
  }
}

/** Pull offers from backend and rebuild both URL caches. Call on startup/re-auth. */
export async function pullOfferUrlCache(): Promise<void> {
  try {
    const auth = await getAuth();
    if (!auth) return;

    const response = await fetch(`${__CONVEX_SITE_URL__}/extension/offers-pull`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth.token}` },
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

    await chrome.storage.local.set({
      [OFFER_URL_CACHE_KEY]: enrolledCache,
      [DETECTED_OFFER_URL_CACHE_KEY]: detectedCache,
    });
  } catch (e) {
    console.error("[NextCard Offers] pullOfferUrlCache error:", e);
  }
}
