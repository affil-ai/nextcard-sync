import { readOfferSelection, selectEligibleOffers } from "../lib/offer-selection";
/**
 * Citi Offers — discover cards and enroll all eligible merchant offers.
 *
 * All Citi API calls go through the service worker's executeScript (MAIN world)
 * because Citi's API requires same-origin context with session cookies.
 * Auth headers are built from Citi cookies read via document.cookie in MAIN world.
 */

// ── Types ──────────────────────────────────────────────────

interface CitiCard {
  accountId: string;
  name: string;
  lastDigits: string | null;
  displayAccountNumber: string | null;
}

interface CitiOffer {
  offerId: string;
  name: string;
  enrolled: boolean;
  offerTitle: string | null;
  offerDiscountType: string | null;
  merchantCategory: string | null;
  offerEndDate: string | null;
  redemptionType: string | null;
  merchantImageUrl: string | null;
}

// ── Helpers ────────────────────────────────────────────────

class CitiReadError extends Error {
  constructor(readonly code: "session_expired" | "request_failed" | "invalid_response") {
    super(code === "session_expired" ? "Sign in to Citi again, then check offers."
      : code === "invalid_response" ? "Citi returned an unexpected response. Check again."
      : "Citi could not return your offers. Check again.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Use the requesting tab's Citi session. Never treat a failed read as an empty listing. */
function citiFetch(url: string, method: string, body: string | null): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: 0, data: null }), 30_000);
    chrome.runtime.sendMessage(
      { type: "CITI_OFFERS_FETCH", url, method, body },
      (resp: unknown) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError || !isRecord(resp) || typeof resp.status !== "number") {
          resolve({ status: 0, data: null });
        } else {
          resolve({ status: resp.status, data: resp.data });
        }
      },
    );
  });
}

function readCitiResponse(resp: { status: number; data: unknown }): Record<string, unknown> {
  if (resp.status === 401 || resp.status === 403) throw new CitiReadError("session_expired");
  if (resp.status !== 200) throw new CitiReadError("request_failed");
  if (!isRecord(resp.data)) throw new CitiReadError("invalid_response");
  return resp.data;
}

// ── Card Discovery ─────────────────────────────────────────

async function discoverCards(): Promise<CitiCard[]> {
  const resp = await citiFetch(
    "https://online.citi.com/gcgapi/prod/public/v1/v2/digital/customers/dashboardTiles/accountDetails",
    "GET",
    null,
  );

  const data = readCitiResponse(resp);
  const creditCard = data.creditCardAccount;
  if (!isRecord(creditCard) || !Array.isArray(creditCard.accountDetails)) {
    throw new CitiReadError("invalid_response");
  }
  const accounts: Record<string, unknown>[] = [];
  for (const account of creditCard.accountDetails) {
    if (!isRecord(account) || typeof account.accountStatus !== "string"
      || typeof account.accountId !== "string" || !account.accountId) {
      throw new CitiReadError("invalid_response");
    }
    accounts.push(account);
  }

  return accounts
    .filter((a) => {
      // Log why cards are filtered out
      return a.accountStatus === "ACTIVE";
    })
    .map((a) => ({
      accountId: (a.accountId ?? "") as string,
      name: (a.productName ?? a.accountName ?? "Unknown Card") as string,
      lastDigits: (a.displayAccountNumber ?? null) as string | null,
      displayAccountNumber: (a.displayAccountNumber ?? null) as string | null,
    }));
}

// ── Offer Listing ──────────────────────────────────────────

async function listOffers(accountId: string): Promise<CitiOffer[]> {
  const resp = await citiFetch(
    "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/merchantOffers/retrieve",
    "POST",
    JSON.stringify({ accountId }),
  );

  const data = readCitiResponse(resp);
  if (!Array.isArray(data.merchantOffers)) throw new CitiReadError("invalid_response");
  const merchantOffers = data.merchantOffers;

  // Flatten offers from all categories, deduplicate by offerId
  const seen = new Set<string>();
  const offers: CitiOffer[] = [];

  for (const group of merchantOffers) {
    if (!isRecord(group) || !Array.isArray(group.offers)) throw new CitiReadError("invalid_response");
    for (const o of group.offers) {
      if (!isRecord(o) || typeof o.offerId !== "string" || !o.offerId) {
        throw new CitiReadError("invalid_response");
      }
      const offerId = o.offerId;
      if (seen.has(offerId)) continue;
      seen.add(offerId);
      offers.push({
        offerId,
        name: (o.merchantName ?? o.offerTitle ?? "Unknown") as string,
        enrolled: (o.enrollmentStatus === "ENROLLED") || (o.enrolled === true) || (o.offerStatus === "ENROLLED"),
        offerTitle: (o.offerTitle ?? null) as string | null,
        offerDiscountType: (o.offerDiscountType ?? null) as string | null,
        merchantCategory: (o.merchantCategory ?? null) as string | null,
        offerEndDate: (o.offerEndDate ?? null) as string | null,
        redemptionType: (o.redemptionType ?? null) as string | null,
        merchantImageUrl: (o.merchantImageURL ?? null) as string | null,
      });
    }
  }

  return offers;
}

// ── Enrollment ─────────────────────────────────────────────

let cancelled = false;
let activeOfferRunId: string | null = null;
let useFallbackUrl = false;

async function enrollOffer(offerId: string, accountId: string): Promise<boolean> {
  const url = useFallbackUrl
    ? "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/merchantOffers/enrollment"
    : "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/accounts/rewards/specialOffers/enrollMerchantOffer";

  const resp = await citiFetch(url, "POST", JSON.stringify({ offerId, accountId }));

  // 404 on primary → switch to fallback
  if (resp.status === 404 && !useFallbackUrl) {
    useFallbackUrl = true;
    return enrollOffer(offerId, accountId);
  }

  if (resp.status !== 200) return false;

  const data = resp.data as Record<string, unknown> | null;
  return !!((data?.EnrolledOfferInfo as Record<string, unknown>)?.enrollmentId || data?.enrollmentId);
}

// ── Runner ─────────────────────────────────────────────────

function sendProgress(data: Record<string, unknown>) {
  chrome.runtime.sendMessage({
    type: "CITI_OFFERS_PROGRESS",
    runId: activeOfferRunId,
    ...data,
  }).catch(() => {});
}

async function runEnrollment(
  selectedAccountIds: string[],
  cards: CitiCard[],
  maxOffers: number | null,
  selection: Record<string, string[]> | null,
) {
  cancelled = false;
  useFallbackUrl = false;
  sendProgress({ status: "fetching" });

  let offersRemaining = maxOffers;
  const offersByCard: Array<{ card: CitiCard; offers: CitiOffer[] }> = [];
  for (const accountId of selectedAccountIds) {
    const card = cards.find((candidate) => candidate.accountId === accountId);
    if (!card || offersRemaining === 0) continue;
    const offers = await listOffers(accountId);
    const availableOffers = selectEligibleOffers(offers.filter((offer) => !offer.enrolled), selection?.[accountId]);
    const selectedOffers = offersRemaining == null
      ? availableOffers
      : availableOffers.slice(0, offersRemaining);
    offersByCard.push({ card, offers: selectedOffers });
    if (offersRemaining != null) offersRemaining -= selectedOffers.length;
  }
  const total = offersByCard.reduce((sum, entry) => sum + entry.offers.length, 0);

  if (total === 0) {
    chrome.runtime.sendMessage({
      type: "CITI_OFFERS_COMPLETE",
      runId: activeOfferRunId,
      added: 0,
      failed: 0,
      total: 0,
      cancelled: false,
      enrolledByCard: [],
    }).catch(() => {});
    return;
  }

  let added = 0;
  let failed = 0;
  const enrolledByCard: Array<{ card: CitiCard; offers: CitiOffer[] }> = [];

  for (const entry of offersByCard) {
    const enrolledOffers: CitiOffer[] = [];
    for (const offer of entry.offers) {
      if (cancelled) break;

      const ok = await enrollOffer(offer.offerId, entry.card.accountId);
      if (ok) { added++; enrolledOffers.push(offer); }
      else failed++;

      sendProgress({ added, failed, total });
    }
    enrolledByCard.push({ card: entry.card, offers: enrolledOffers });
    if (cancelled) break;
  }

  chrome.runtime.sendMessage({
    type: "CITI_OFFERS_COMPLETE",
    runId: activeOfferRunId,
    added,
    failed,
    total,
    cancelled,
    enrolledByCard: enrolledByCard.map(({ card, offers }) => ({
      accountId: card.accountId,
      cardName: card.name,
      cardLastDigits: card.lastDigits,
      enrolledOffers: offers.map((offer) => {
        const amountMatch = offer.offerTitle?.match(/(\$?\d+(?:\.\d+)?)\s*%?\s*Back/i);
        const rawAmount = amountMatch ? parseFloat(amountMatch[1].replace("$", "")) : null;
        const isPercentage = offer.offerDiscountType === "PERCENTAGE"
          || (offer.offerTitle?.includes("%") ?? false);
        return {
          issuerOfferId: offer.offerId,
          merchantName: offer.name,
          offerValue: offer.offerTitle,
          category: offer.merchantCategory,
          expirationDate: offer.offerEndDate,
          rewardType: isPercentage ? "percentage" as const : offer.offerDiscountType === "ABSOLUTE" ? "flat_cash" as const : null,
          rewardAmount: rawAmount,
          rewardCurrency: "cash",
          maxReward: null,
          minSpend: null,
          merchantUrl: offer.name?.includes(".") ? offer.name : null,
          merchantLogoUrl: offer.merchantImageUrl,
          redemptionChannel: offer.redemptionType === "Online" ? "online" as const
            : offer.redemptionType === "Online_instore" ? "both" as const
            : offer.redemptionType ? "in_store" as const
            : null,
        };
      }),
    })),
  }).catch(() => {});
}

// ── Message listener ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CITI_OFFERS_DISCOVER") {
    activeOfferRunId = typeof message.runId === "string" ? message.runId : activeOfferRunId;
    (async () => {
      const cards = await discoverCards();
      if (cards.length === 0) {
        sendResponse({ type: "CITI_OFFERS_READY", cards: [], offerCounts: {}, error: "no_cards" });
        return;
      }
      const probes = await Promise.all(cards.map((c) => listOffers(c.accountId)));
      const offerCounts: Record<string, number> = {};
      for (let i = 0; i < cards.length; i++) {
        offerCounts[cards[i].accountId] = probes[i].filter((o) => !o.enrolled).length;

        if (probes[i].length > 0) {
          chrome.runtime.sendMessage({
            type: "CITI_OFFERS_DETECTED",
            runId: activeOfferRunId,
            accountId: cards[i].accountId,
            cardName: cards[i].name,
            cardLastDigits: cards[i].lastDigits,
            detectedOffers: probes[i].map((o) => ({
              issuerOfferId: o.offerId,
              merchantName: o.name,
              offerValue: o.offerTitle,
              category: o.merchantCategory,
              expirationDate: o.offerEndDate,
              rewardType: (o.offerDiscountType === "PERCENTAGE" || o.offerTitle?.includes("%")) ? "percentage" as const : o.offerDiscountType === "ABSOLUTE" ? "flat_cash" as const : null,
              rewardAmount: (() => { const m = o.offerTitle?.match(/(\$?\d+(?:\.\d+)?)\s*%?\s*Back/i); return m ? parseFloat(m[1].replace("$", "")) : null; })(),
              rewardCurrency: "cash" as string | null,
              maxReward: null as number | null,
              minSpend: null as number | null,
              merchantUrl: o.name?.includes(".") ? o.name : null,
              merchantLogoUrl: o.merchantImageUrl,
              redemptionChannel: o.redemptionType === "Online" ? "online" as const
                : o.redemptionType === "Online_instore" ? "both" as const
                : o.redemptionType ? "in_store" as const
                : null,
            })),
          }).catch(() => {});
        }
      }
      sendResponse({
        type: "CITI_OFFERS_READY",
        cards: cards.map((c) => ({ id: c.accountId, name: c.name, lastDigits: c.lastDigits })),
        offerCounts,
        offersByCard: Object.fromEntries(cards.map((card, index) => [card.accountId,
          probes[index].filter((offer) => !offer.enrolled).map((offer) => ({
            id: offer.offerId, name: offer.name, value: offer.offerTitle, details: null, terms: null,
          }))])),
        error: undefined,
      });
    })().catch((error: unknown) => sendResponse({
      type: "CITI_OFFERS_READY", cards: [], offerCounts: {},
      error: error instanceof CitiReadError ? error.code : "request_failed",
    }));
    return true;
  }

  if (message.type === "CITI_OFFERS_RUN") {
    activeOfferRunId = typeof message.runId === "string" ? message.runId : null;
    const cards = Array.isArray(message.cards)
      ? message.cards.flatMap((card: unknown): CitiCard[] => {
          if (
            card === null
            || typeof card !== "object"
            || typeof (card as { id?: unknown }).id !== "string"
            || typeof (card as { name?: unknown }).name !== "string"
          ) {
            return [];
          }
          const candidate = card as { id: string; name: string; lastDigits?: unknown };
          return [{
            accountId: candidate.id,
            name: candidate.name,
            lastDigits: typeof candidate.lastDigits === "string" ? candidate.lastDigits : null,
            displayAccountNumber: typeof candidate.lastDigits === "string" ? candidate.lastDigits : null,
          }];
        })
      : [];
    const selectedAccountIds = Array.isArray(message.selectedCardKeys)
      ? message.selectedCardKeys.filter((accountId: unknown): accountId is string => (
          typeof accountId === "string"
        ))
      : [message.accountId].filter((accountId): accountId is string => (
          typeof accountId === "string"
        ));
    runEnrollment(
      selectedAccountIds,
      cards.length > 0
        ? cards
        : [{
            accountId: message.accountId,
            name: (message.cardName as string) ?? "Citi card",
            lastDigits: (message.cardLastDigits as string) ?? null,
            displayAccountNumber: (message.cardLastDigits as string) ?? null,
          }],
      typeof message.maxOffers === "number"
        ? Math.max(0, Math.floor(message.maxOffers))
        : null,
      readOfferSelection(message.selectedOfferIdsByCard),
    ).catch((error: unknown) => chrome.runtime.sendMessage({
      type: "CITI_OFFERS_COMPLETE", runId: activeOfferRunId, added: 0, failed: 0,
      error: error instanceof Error ? error.message : "Could not check selected offers. Check again.", enrolledByCard: [],
    }).catch(() => {}));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "CITI_OFFERS_STOP") {
    if (
      typeof message.runId === "string"
      && activeOfferRunId
      && message.runId !== activeOfferRunId
    ) {
      sendResponse({ ok: false });
      return true;
    }
    cancelled = true;
    sendResponse({ ok: true });
    return true;
  }
});
