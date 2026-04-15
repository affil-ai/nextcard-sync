/**
 * Chase Offers — discover cards and enroll all eligible merchant offers.
 *
 * Card discovery: POST to accounts list API (same-origin, credentials included).
 * Offer listing: GET to customer-offers API with path-params header.
 * Enrollment: GET to reco.chase.com (cross-site, credentials omitted — no CORS issues).
 *
 * All runs from the content script on secure*.chase.com. Card/offer APIs are
 * same-origin so no CORS. Enrollment is cross-origin but credentials:"omit" means no preflight.
 */

// ── Types ──────────────────────────────────────────────────

interface ChaseCard {
  id: string;
  name: string;
  lastDigits: string | null;
}

interface ChaseOffer {
  offerId: string;
  name: string;
  status: string;
  recommendationIdentifier: string;
  offerImpressionTokenIdentifier: string;
  cardId: string;
  offerHeaderText: string | null;
  offerRewardTypeCode: string | null;
  offerAmount: number | null;
  maximumRewardAmount: number | null;
  minimumSpendAmount: number | null;
  category: string | null;
  offerEndTimestamp: string | null;
  shortMessageText: string | null;
  merchantUrl: string | null;
}

// ── Helpers ────────────────────────────────────────────────

function getHostname(): string {
  return location.hostname.replace(".chase.com", "");
}

function getEnterprisePartyId(): string | null {
  const cookies = document.cookie;
  const pc = cookies.split(";").find((c) => c.trim().startsWith("PC_1_0="));
  if (!pc) return null;
  const decoded = decodeURIComponent(pc.split("=").slice(1).join("="));
  const match = decoded.match(/ECI=([^|]+)/);
  return match ? match[1] : null;
}

// ── Card Discovery ─────────────────────────────────────────

async function discoverCards(): Promise<ChaseCard[]> {
  const host = getHostname();
  try {
    const resp = await fetch(`https://${host}.chase.com/svc/rr/accounts/secure/v1/dashboard/overview/accounts/list`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "*/*",
        "x-jpmc-csrf-token": "NONE",
        "x-jpmc-channel": "id=C30",
      },
      credentials: "include",
      body: "refresh=false",
    });

    if (!resp.ok) return [];
    const data = await resp.json();

    const accounts = (data.accounts ?? []) as Record<string, unknown>[];
    return accounts
      .filter((a) => {
        const detail = a.detail as Record<string, unknown> | undefined;
        if (detail?.closed) return false;
        return a.groupType === "CARD";
      })
      .map((a) => ({
        id: String(a.id ?? ""),
        name: (a.nickname ?? a.productDescription ?? "Unknown Card") as string,
        lastDigits: (a.mask ?? null) as string | null,
      }));
  } catch (e) {
    console.error("[NextCard Chase Offers] discoverCards error:", e);
    return [];
  }
}

// ── Offer Listing ──────────────────────────────────────────

async function listOffers(cardIds: string[], primaryCardId: string): Promise<ChaseOffer[]> {
  const host = getHostname();
  const epi = getEnterprisePartyId();
  if (!epi) {
    console.error("[NextCard Chase Offers] No enterprise party ID found");
    return [];
  }

  const url = `https://${host}.chase.com/svc/wr/profile/secure/gateway/ccb/marketing/offer-management/digital-customer-targeted-offers/v2/customer-offers?offer-count=&offerStatusNameList=NEW,ACTIVATED,SERVED&source-application-system-name=CHASE_WEB&source-request-component-name=OFFERS_HUB_CAROUSELS&is-include-summary=true`;

  const pathParams = {
    enterprisePartyIdentifier: epi,
    digitalAccountIdentifierList: cardIds,
    primaryDigitalAccountIdentifierList: [primaryCardId],
  };

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        "path-params": JSON.stringify(pathParams),
        "channel-identifier": "C30",
        "channel-type": "WEB",
        "x-jpmc-channel": "id=C30",
        "x-jpmc-csrf-token": "NONE",
      },
      credentials: "include",
    });

    if (!resp.ok) return [];
    const data = await resp.json();

    const customerOffers = data.customerOffers as Record<string, unknown>[] | undefined;
    if (!customerOffers?.length) return [];

    const offers = (customerOffers[0].offers ?? []) as Record<string, unknown>[];

    return offers
      .filter((o) => o.offerStatusName !== "ACTIVATED")
      .map((o) => {
        const details = o.offerDetails as Record<string, unknown> | undefined;
        const display = o.offerDisplayDetails as Record<string, unknown> | undefined;
        const merchant = o.merchantDetails as Record<string, unknown> | undefined;
        const merchantName = (o.MerchantName ?? merchant?.merchantName ?? details?.merchantName ?? details?.offerTitle ?? display?.offerHeaderText ?? "Unknown") as string;
        const options = (details?.offerOptions as Array<Record<string, unknown>> | undefined)?.[0];
        const categories = o.offerCategories as Array<{ offerCategoryName: string }> | undefined;
        return {
          offerId: (o.offerIdentifier ?? "") as string,
          name: merchantName,
          status: (o.offerStatusName ?? "NEW") as string,
          recommendationIdentifier: (o.recommendationIdentifier ?? "") as string,
          offerImpressionTokenIdentifier: (o.offerImpressionTokenIdentifier ?? "") as string,
          cardId: primaryCardId,
          offerHeaderText: (display?.offerHeaderText ?? null) as string | null,
          offerRewardTypeCode: (options?.offerRewardTypeCode ?? null) as string | null,
          offerAmount: (options?.offerAmount ?? null) as number | null,
          maximumRewardAmount: (options?.maximumRewardOfferAmount ?? null) as number | null,
          minimumSpendAmount: (options?.minimumSpendingAmount ?? null) as number | null,
          category: (categories?.[0]?.offerCategoryName ?? null) as string | null,
          offerEndTimestamp: (details?.offerEndTimestamp ?? null) as string | null,
          shortMessageText: (display?.shortMessageText ?? null) as string | null,
          merchantUrl: ((display?.links as Record<string, Record<string, unknown>> | undefined)?.displayLink?.linkText ?? null) as string | null,
        };
      });
  } catch (e) {
    console.error("[NextCard Chase Offers] listOffers error:", e);
    return [];
  }
}

// ── Enrollment ─────────────────────────────────────────────

async function enrollOffer(offer: ChaseOffer, epi: string): Promise<boolean> {
  const host = getHostname();
  const url = `https://reco.chase.com/events/recoengine/public/recommendation/ccb/sales-relationship/crm/personalization-recommendation-interactions/v1/customer-interaction?recommendation-event-type-code=CLICK&recommendation-identifier=${offer.recommendationIdentifier}&enterprise-party-identifier=${epi}&source-application-system-name=CHASE_WEB&source-request-component-name=OFFERS_HUB_ALL&offer-identifier=${offer.offerId}&offer-impression-token-identifier=${offer.offerImpressionTokenIdentifier}&request-context=MERCHANT_OFFERS&offer-session-token-identifier=&digital-account-identifier=${offer.cardId}`;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
        origin: `https://${host}.chase.com`,
        referer: `https://${host}.chase.com/`,
      },
      credentials: "omit",
      redirect: "follow",
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── Runner ─────────────────────────────────────────────────

let cancelled = false;

function sendProgress(data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type: "CHASE_OFFERS_PROGRESS", ...data }).catch(() => {});
}

async function runEnrollment(cardId: string, allCardIds: string[]) {
  cancelled = false;

  sendProgress({ status: "fetching" });
  const offers = await listOffers(allCardIds, cardId);
  console.log(`[NextCard Chase Offers] Found ${offers.length} eligible offers`);

  if (offers.length === 0) {
    chrome.runtime.sendMessage({ type: "CHASE_OFFERS_COMPLETE", added: 0 }).catch(() => {});
    return;
  }

  const epi = getEnterprisePartyId();
  if (!epi) {
    chrome.runtime.sendMessage({ type: "CHASE_OFFERS_COMPLETE", added: 0 }).catch(() => {});
    return;
  }

  // Fire all enrollments in parallel — Chase enrollment is a fast cross-origin GET
  const results = await Promise.allSettled(
    offers.map((offer) => enrollOffer(offer, epi)),
  );

  let added = 0;
  let failed = 0;
  const enrolledOffers: ChaseOffer[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) { added++; enrolledOffers.push(offers[i]); }
    else failed++;
  }

  sendProgress({ added, failed, total: offers.length });
  console.log(`[NextCard Chase Offers] Done: ${added} added, ${failed} failed`);
  chrome.runtime.sendMessage({
    type: "CHASE_OFFERS_COMPLETE",
    added,
    failed,
    cardId,
    cardName: selectedCardName,
    cardLastDigits: selectedCardLastDigits,
    enrolledOffers: enrolledOffers.map((o) => ({
      issuerOfferId: o.offerId,
      merchantName: o.name,
      offerValue: o.offerHeaderText,
      category: o.category,
      expirationDate: o.offerEndTimestamp,
      rewardType: o.offerRewardTypeCode === "PERCENTAGE" ? "percentage" : o.offerRewardTypeCode === "FLAT_AMOUNT" ? "flat_cash" : null,
      rewardAmount: o.offerAmount,
      rewardCurrency: "cash",
      maxReward: o.maximumRewardAmount === 0 ? null : o.maximumRewardAmount,
      minSpend: o.minimumSpendAmount === 0 ? null : o.minimumSpendAmount,
      merchantUrl: o.merchantUrl,
    })),
  }).catch(() => {});
}

// ── Message listener ───────────────────────────────────────

let selectedCardName = "";
let selectedCardLastDigits: string | null = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CHASE_OFFERS_DISCOVER") {
    (async () => {
      const cards = await discoverCards();
      sendResponse({
        type: "CHASE_OFFERS_READY",
        cards: cards.map((c) => ({ id: c.id, name: c.name, lastDigits: c.lastDigits })),
        error: cards.length === 0 ? "no_cards" : undefined,
      });
    })();
    return true;
  }

  if (message.type === "CHASE_OFFERS_RUN") {
    selectedCardName = (message.cardName as string) ?? "";
    selectedCardLastDigits = (message.cardLastDigits as string) ?? null;
    runEnrollment(message.cardId, message.allCardIds ?? [message.cardId]);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "CHASE_OFFERS_STOP") {
    cancelled = true;
    sendResponse({ ok: true });
    return true;
  }
});

console.log("[NextCard Chase Offers] Content script loaded");
