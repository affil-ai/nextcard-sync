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
    enrolledAt: string;
  }>;
}

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const STORAGE_KEY = "pendingOfferSyncs";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postOfferSync(payload: OfferSyncPayload): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuth();
  if (!auth) {
    return { ok: false, error: "Not signed in to NextCard" };
  }

  const response = await fetch(`${__CONVEX_SITE_URL__}/extension/offers-sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    return { ok: false, error: (result as Record<string, string>).error ?? `HTTP ${response.status}` };
  }

  return { ok: true };
}

async function persistForRetry(payload: OfferSyncPayload): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const pending: OfferSyncPayload[] = stored[STORAGE_KEY] ?? [];
    pending.push(payload);
    await chrome.storage.local.set({ [STORAGE_KEY]: pending });
    console.log(`[NextCard Offers Sync] Persisted payload for retry (${pending.length} pending)`);
  } catch (e) {
    console.error("[NextCard Offers Sync] Failed to persist for retry:", e);
  }
}

export async function syncOffersToNextCard(payload: OfferSyncPayload): Promise<void> {
  if (payload.offers.length === 0) return;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await postOfferSync(payload);
      if (result.ok) {
        console.log(`[NextCard Offers Sync] Synced ${payload.offers.length} ${payload.issuer} offers`);
        return;
      }

      // Auth errors won't resolve with retry
      if (result.error?.includes("token") || result.error?.includes("401")) {
        console.warn(`[NextCard Offers Sync] Auth error, skipping retry: ${result.error}`);
        await persistForRetry(payload);
        return;
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
  await persistForRetry(payload);
}

/** Retry any pending syncs stored from previous failures. Call on startup. */
export async function retryPendingOfferSyncs(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const pending: OfferSyncPayload[] = stored[STORAGE_KEY] ?? [];
    if (pending.length === 0) return;

    console.log(`[NextCard Offers Sync] Retrying ${pending.length} pending syncs`);

    const remaining: OfferSyncPayload[] = [];
    for (const payload of pending) {
      const result = await postOfferSync(payload);
      if (!result.ok) {
        remaining.push(payload);
      } else {
        console.log(`[NextCard Offers Sync] Retried ${payload.offers.length} ${payload.issuer} offers`);
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
