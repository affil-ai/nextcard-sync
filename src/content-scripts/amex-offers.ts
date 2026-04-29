/**
 * Amex Offers — discover cards and enroll all eligible merchant offers.
 *
 * Card discovery: parses the dashboard HTML for the Transit-encoded productsList.
 * Offer listing: uses ReadOffersHubPresentation.web.v1 via executeScript (MAIN world).
 * Enrollment: batched via executeScript in MAIN world (chunks of 10).
 *
 * All API calls run in MAIN world via the service worker's chrome.scripting.executeScript
 * to avoid CORS issues (same-site origin, session cookies included).
 */

// ── Types ──────────────────────────────────────────────────

interface AmexCard {
  id: string;
  name: string;
  lastDigits: string | null;
  accountKey: string | null;
}

interface AmexOffer {
  offerId: string;
  name: string;
  status: string;
  shortDescription: string | null;
  category: string | null;
  expirationText: string | null;
  merchantUrl: string | null;
  merchantLogoUrl: string | null;
  redemptionChannel: "online" | "in_store" | "both" | null;
}

// ── Helpers ────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readLastDigits(product: Record<string, unknown>): string | null {
  const candidates = [
    product.display_account_number,
    product.displayAccountNumber,
    product.lastDigits,
    product.lastFour,
    product.last4,
    product.maskedAccountNumber,
    product.accountNumber,
  ];

  for (const candidate of candidates) {
    const text = readString(candidate);
    const digits = text?.match(/\d{4}(?!.*\d)/)?.[0] ?? null;
    if (digits) return digits;
  }

  return null;
}

function isGenericAmexCardName(name: string | null | undefined): boolean {
  if (!name) return true;
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "amex card" ||
    normalized === "american express card" ||
    normalized === "unknown card" ||
    /^card\s*[·.*-]*\s*\d{0,4}$/.test(normalized)
  );
}

function mergeDiscoveredCards(
  productCards: AmexCard[],
  dashboardCards: AmexCard[],
): AmexCard[] {
  if (productCards.length === 0) return dashboardCards;
  if (dashboardCards.length === 0) return productCards;

  return productCards.map((card, index) => {
    const match =
      dashboardCards.find((candidate) => candidate.id === card.id)
      ?? dashboardCards.find((candidate) => candidate.accountKey && candidate.accountKey === card.accountKey)
      ?? dashboardCards.find((candidate) => candidate.lastDigits && candidate.lastDigits === card.lastDigits)
      ?? dashboardCards[index];

    if (!match) return card;

    return {
      id: card.id,
      name: isGenericAmexCardName(card.name) ? match.name : card.name,
      lastDigits: card.lastDigits ?? match.lastDigits,
      accountKey: card.accountKey ?? match.accountKey,
    };
  });
}

/** Route an API call through the service worker's executeScript (MAIN world) */
function amexApiFetch(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "AMEX_OFFERS_FETCH", url, method: options.method, headers: options.headers, body: options.body },
      (resp) => {
        if (chrome.runtime.lastError || !resp) resolve({ status: 0, data: null });
        else resolve(resp);
      },
    );
  });
}

/** Inject products.js into the Amex page's MAIN world and read digitalData.products from localStorage */
function injectAndReadProducts(): Promise<AmexCard[]> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "AMEX_OFFERS_READ_PRODUCTS" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.products) resolve([]);
      else {
        const products = resp.products as Array<Record<string, unknown>>;
        const cards: AmexCard[] = products
          .filter((p) => {
            const status = p.status as string[] | undefined;
            const first = status?.length ? status[0] : null;
            const lob = p.lineOfBusiness as string | undefined;
            return first !== "Canceled" && (lob === "CONSUMER" || lob === "COMPANY_CARD");
          })
          .map((p) => ({
            id: (p.id ?? "") as string,
            name: readString(p.description) ?? "Unknown Card",
            lastDigits: readLastDigits(p),
            accountKey: readString(p.accountKey),
          }));
        resolve(cards);
      }
    });
  });
}

// ── Card Discovery ─────────────────────────────────────────

/** Primary: read digitalData.products from the Amex page (injected via MAIN world) */
async function discoverCardsFromProducts(): Promise<AmexCard[]> {
  try {
    const cards = await injectAndReadProducts();
    return cards;
  } catch (e) {
    console.error("[NextCard Amex Offers] digitalData.products error:", e);
    return [];
  }
}

/** Fallback: parse the dashboard HTML for Transit-encoded productsList */
async function discoverCardsFromDashboard(): Promise<AmexCard[]> {
  try {
    const resp = await fetch("https://global.americanexpress.com/dashboard", {
      credentials: "include",
      headers: { accept: "text/html" },
    });
    if (!resp.ok || resp.url.includes("/login")) return [];

    const html = await resp.text();
    const startToken = "window.__INITIAL_STATE__ = ";
    const startIdx = html.indexOf(startToken);
    if (startIdx === -1) return [];

    let raw = html.substring(startIdx + startToken.length);
    const endIdx = raw.indexOf(";\n");
    if (endIdx === -1) return [];
    raw = raw.substring(0, endIdx);

    let decoded: string;
    try { decoded = JSON.parse(raw); } catch { decoded = raw; }

    const plIdx = decoded.indexOf("productsList");
    if (plIdx === -1) return [];

    const chunk = decoded.substring(plIdx, plIdx + 50000);
    const cards: AmexCard[] = [];
    const tokenPattern = /"([A-Z0-9]{10,20})",\["\^ "/g;
    let match;

    while ((match = tokenPattern.exec(chunk)) !== null) {
      const accountToken = match[1];
      if (cards.some((c) => c.id === accountToken)) continue;

      const section = chunk.substring(match.index, match.index + 3000);

      const descMatch = section.match(/"description","([^"]+)"/);
      const name = descMatch ? descMatch[1] : `Card ····${accountToken.slice(-4)}`;

      const statusMatch = section.match(/"account_status",\["([^"]+)"/);
      if (statusMatch && statusMatch[1] === "Canceled") continue;

      const digitsMatch = section.match(/"display_account_number","(\d+)"/);
      const lastDigits = digitsMatch ? digitsMatch[1].slice(-4) : null;

      let accountKey: string | null = null;
      const keyMatch = decoded.match(new RegExp(`"accountToken","${accountToken}","accountKey","([^"]+)"`));
      if (keyMatch) accountKey = keyMatch[1];

      cards.push({ id: accountToken, name, lastDigits, accountKey });
    }

    return cards;
  } catch (e) {
    console.error("[NextCard Amex Offers] discoverCardsFromDashboard error:", e);
    return [];
  }
}

/** Try digitalData.products first, fall back to dashboard HTML parsing */
async function discoverCards(): Promise<AmexCard[]> {
  const productCards = await discoverCardsFromProducts();
  const needsDashboardEnrichment = productCards.some(
    (card) => isGenericAmexCardName(card.name) || !card.lastDigits,
  );

  if (productCards.length > 0 && !needsDashboardEnrichment) return productCards;

  const dashboardCards = await discoverCardsFromDashboard();
  return mergeDiscoveredCards(productCards, dashboardCards);
}

// ── Offer Listing ──────────────────────────────────────────

async function listOffers(cardId: string): Promise<AmexOffer[] | null> {
  try {
    const resp = await amexApiFetch("https://functions.americanexpress.com/ReadOffersHubPresentation.web.v1", {
      method: "POST",
      headers: { accept: "application/json", "ce-source": "WEB", "content-type": "application/json" },
      body: JSON.stringify({
        accountNumberProxy: cardId,
        locale: "en-US",
        offerPage: "page1",
        requestType: "OFFERSHUB_LANDING",
      }),
    });

    if (resp.status !== 200 || !resp.data) return null;

    const data = resp.data as Record<string, unknown>;
    const recList = ((data.recommendedOffers as Record<string, Record<string, unknown[]>>)?.offersList?.page1) ?? [];
    const addedList = ((data.addedToCard as Record<string, Record<string, unknown[]>>)?.offersList?.page1) ?? [];
    const all = [...recList, ...addedList] as Record<string, unknown>[];

    if (all.length === 0) return null;

    return all
      .filter((o) => o.offerType === "MERCHANT")
      .map((o) => ({
        offerId: (o.offerId ?? o.id ?? "") as string,
        name: (o.title ?? o.merchantName ?? "Unknown") as string,
        status: ((o.enrollmentDetails as Record<string, unknown>)?.status ?? "NOT_ENROLLED") as string,
        shortDescription: (o.shortDescription ?? null) as string | null,
        category: ((o.applicableCategories as Array<{ text: string }> | undefined)?.[0]?.text ?? null) as string | null,
        expirationText: ((o.expiration as { text: string } | undefined)?.text ?? null) as string | null,
        merchantUrl: ((o.longDescription as string)?.match(/(?:at|website)\s+(?:[\w.-]+\.(?:com|net|org|co|io|shop|store)\b)/i)?.[0]?.replace(/^(?:at|website)\s+/i, "") ?? null) as string | null,
        merchantLogoUrl: (o.image ?? null) as string | null,
        redemptionChannel: (() => {
          const filters = (o.applicableFilters as Array<{ optionType: string }> | undefined) ?? [];
          const types = filters.map((f) => f.optionType);
          const hasOnline = types.includes("ONLINE");
          const hasInStore = types.includes("IN_STORE");
          if (hasOnline && hasInStore) return "both" as const;
          if (hasOnline) return "online" as const;
          if (hasInStore) return "in_store" as const;
          return null;
        })(),
      }));
  } catch (e) {
    console.error("[NextCard Amex Offers] listOffers error:", e);
    return null;
  }
}

// ── Enrollment ─────────────────────────────────────────────

let cancelled = false;

// Proactive rate limiting — match CardPointers' params
const ENROLL_BASE_DELAY_MS = 150;
const ENROLL_JITTER_MIN_MS = 50;
const ENROLL_JITTER_MAX_MS = 150;
const ENROLL_PAUSE_THRESHOLD = 100;
const ENROLL_PAUSE_DELAY_MS = 3000;
let enrollRequestsSincePause = 0;

function enrollJitter(): number {
  return Math.floor(Math.random() * (ENROLL_JITTER_MAX_MS - ENROLL_JITTER_MIN_MS + 1)) + ENROLL_JITTER_MIN_MS;
}

function sendProgress(data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type: "AMEX_OFFERS_PROGRESS", ...data }).catch(() => {});
}

/** Enroll a single offer via MAIN world executeScript */
function enrollSingleOffer(cardId: string, offerId: string, locale: string): Promise<"added" | "skipped" | "failed"> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "AMEX_OFFERS_ENROLL_ONE", cardId, offerId, locale },
      (resp) => {
        if (chrome.runtime.lastError || !resp) resolve("failed");
        else resolve(resp.result ?? "failed");
      },
    );
  });
}

async function runEnrollment(cardId: string) {
  cancelled = false;
  enrollRequestsSincePause = 0;

  let totalAdded = 0;
  let totalAlreadyAdded = 0;
  let totalFailed = 0;
  let totalEligible = 0;
  let round = 0;
  const MAX_ROUNDS = 5;
  const enrolledOffers: AmexOffer[] = [];
  const enrolledOfferIds = new Set<string>();

  while (round < MAX_ROUNDS && !cancelled) {
    round++;
    sendProgress({ status: "fetching", round, added: totalAdded });

    const offers = await listOffers(cardId);
    if (!offers || offers.length === 0) break;

    const eligible = offers.filter((o) => o.status !== "ENROLLED" && o.status !== "ADDED");
    if (eligible.length === 0) break;

    totalEligible += eligible.length;
    sendProgress({ status: "enrolling", round, added: totalAdded, total: totalEligible });

    let roundAdded = 0;

    for (const offer of eligible) {
      if (cancelled) break;

      const result = await enrollSingleOffer(cardId, offer.offerId, "en-US");
      if (result === "added" || result === "skipped") {
        if (!enrolledOfferIds.has(offer.offerId)) {
          enrolledOfferIds.add(offer.offerId);
          totalAdded++;
          roundAdded++;
          enrolledOffers.push(offer);
        }
        if (result === "skipped") totalAlreadyAdded++;
      } else {
        totalFailed++;
      }

      sendProgress({ added: totalAdded, skipped: totalAlreadyAdded, failed: totalFailed, round, total: totalEligible });

      // Proactive rate limiting
      enrollRequestsSincePause++;
      if (enrollRequestsSincePause >= ENROLL_PAUSE_THRESHOLD) {
        await delay(ENROLL_PAUSE_DELAY_MS + enrollJitter());
        enrollRequestsSincePause = 0;
      } else {
        await delay(ENROLL_BASE_DELAY_MS + enrollJitter());
      }
    }


    if (roundAdded === 0) break;

    if (round < MAX_ROUNDS && !cancelled) {
      sendProgress({ status: "checking_new", round, added: totalAdded });
      await delay(2000);
    }
  }

  chrome.runtime.sendMessage({
    type: "AMEX_OFFERS_COMPLETE",
    added: totalAdded,
    skipped: totalAlreadyAdded,
    failed: totalFailed,
    rounds: round,
    cardId,
    cardName: selectedCardName,
    cardLastDigits: selectedCardLastDigits,
    enrolledOffers: enrolledOffers.map((o) => {
      const desc = o.shortDescription ?? "";
      // Parse structured reward from shortDescription
      // Patterns: "earn 5,000 Membership Rewards® points", "earn $5 back", "Earn 15% back"
      let rewardType: "percentage" | "flat_cash" | "points" | null = null;
      let rewardAmount: number | null = null;
      let rewardCurrency: string | null = null;
      let maxReward: number | null = null;
      let minSpend: number | null = null;

      const pctMatch = desc.match(/(\d+(?:\.\d+)?)\s*%\s*back/i);
      const cashMatch = desc.match(/earn\s+\$(\d+(?:,\d+)*(?:\.\d+)?)\s*back/i);
      const ptsMatch = desc.match(/earn\s+([\d,]+)\s+(?:Membership Rewards|MR)/i);
      const spendMatch = desc.match(/Spend\s+\$(\d+(?:,\d+)*(?:\.\d+)?)/i);
      const maxMatch = desc.match(/up to (?:a total of )?\$(\d+(?:,\d+)*(?:\.\d+)?)/i);

      if (ptsMatch) {
        rewardType = "points";
        rewardAmount = parseFloat(ptsMatch[1].replace(/,/g, ""));
        rewardCurrency = "MR";
      } else if (pctMatch) {
        rewardType = "percentage";
        rewardAmount = parseFloat(pctMatch[1]);
        rewardCurrency = "cash";
      } else if (cashMatch) {
        rewardType = "flat_cash";
        rewardAmount = parseFloat(cashMatch[1].replace(/,/g, ""));
        rewardCurrency = "cash";
      }

      if (spendMatch) {
        minSpend = parseFloat(spendMatch[1].replace(/,/g, ""));
      }
      if (maxMatch) {
        maxReward = parseFloat(maxMatch[1].replace(/,/g, ""));
      }

      return {
        issuerOfferId: o.offerId,
        merchantName: o.name,
        offerValue: o.shortDescription,
        category: o.category,
        expirationDate: o.expirationText,
        rewardType,
        rewardAmount,
        rewardCurrency,
        maxReward,
        minSpend,
        merchantUrl: o.merchantUrl,
        merchantLogoUrl: o.merchantLogoUrl,
        redemptionChannel: o.redemptionChannel,
      };
    }),
  }).catch(() => {});
}

// ── Message listener ───────────────────────────────────────

let selectedCardName = "";
let selectedCardLastDigits: string | null = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "AMEX_OFFERS_DISCOVER") {
    (async () => {
      const cards = await discoverCards();
      if (cards.length === 0) {
        sendResponse({ type: "AMEX_OFFERS_READY", cards: [], offerCounts: {}, error: "no_cards" });
        return;
      }
      // Probe all cards in parallel — validates session and gets per-card unenrolled counts
      const probes = await Promise.all(cards.map((c) => listOffers(c.id)));
      if (probes[0] === null) {
        sendResponse({ type: "AMEX_OFFERS_READY", cards: [], offerCounts: {}, error: "no_cards" });
        return;
      }
      const offerCounts: Record<string, number> = {};
      for (let i = 0; i < cards.length; i++) {
        const offers = probes[i] ?? [];
        const eligible = offers.filter((o) => o.status !== "ENROLLED" && o.status !== "ADDED");
        offerCounts[cards[i].id] = eligible.length;

        if (offers.length > 0) {
          chrome.runtime.sendMessage({
            type: "AMEX_OFFERS_DETECTED",
            cardId: cards[i].id,
            cardName: cards[i].name,
            cardLastDigits: cards[i].lastDigits,
            detectedOffers: offers.map((o) => ({
              issuerOfferId: o.offerId,
              merchantName: o.name,
              offerValue: o.shortDescription,
              category: o.category,
              expirationDate: o.expirationText,
              rewardType: null as "percentage" | "flat_cash" | "points" | null,
              rewardAmount: null as number | null,
              rewardCurrency: null as string | null,
              maxReward: null as number | null,
              minSpend: null as number | null,
              merchantUrl: o.merchantUrl,
              merchantLogoUrl: o.merchantLogoUrl,
              redemptionChannel: o.redemptionChannel,
            })),
          }).catch(() => {});
        }
      }
      sendResponse({
        type: "AMEX_OFFERS_READY",
        cards: cards.map((c) => ({ id: c.id, name: c.name, lastDigits: c.lastDigits, accountKey: c.accountKey })),
        offerCounts,
        error: undefined,
      });
    })();
    return true;
  }

  if (message.type === "AMEX_OFFERS_RUN") {
    selectedCardName = (message.cardName as string) ?? "";
    selectedCardLastDigits = (message.cardLastDigits as string) ?? null;
    runEnrollment(message.cardId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "AMEX_OFFERS_STOP") {
    cancelled = true;
    sendResponse({ ok: true });
    return true;
  }
});
