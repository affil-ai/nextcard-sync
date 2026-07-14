/**
 * Amex Offers — discover cards and enroll all eligible merchant offers.
 *
 * Card discovery: parses the dashboard HTML for the Transit-encoded productsList.
 * Offer listing: uses Offers Hub APIs via executeScript (MAIN world).
 * Enrollment: uses CreateOffersHubEnrollment.web.v1 via executeScript (MAIN world).
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

interface AmexOfferList {
  offers: AmexOffer[];
  eligibleCount: number | null;
  complete: boolean;
  rawOfferCount?: number;
}

const MAX_AMEX_OFFER_PAGES = 50;

interface AmexApiResult {
  status: number;
  data: unknown;
  error?: string;
}

interface AmexEnrollResult {
  result: "added" | "skipped" | "failed";
  status?: number;
  purpose?: unknown;
  message?: unknown;
  explanationCode?: unknown;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLocale(locale: unknown): string {
  const value = readString(locale)?.replace("_", "-") ?? "en-US";
  return value.toLowerCase() === "en-us" ? "en-US" : value;
}

function randomCorrelationId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getUserOffset(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function formatRequestDateTime(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "_",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
    getUserOffset(date),
  ].join("");
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
    const digits = text?.match(/\d+(?!.*\d)/)?.[0] ?? null;
    // Amex exposes a five-digit account suffix in some surfaces. Preserve it
    // for matching, without ever sending a full account number to NextCard.
    if (digits && digits.length >= 4) return digits.slice(-5);
  }

  return null;
}

function readProductId(product: Record<string, unknown>): string | null {
  const candidates = [
    product.id,
    product.accountToken,
    product.opaqueAccountId,
    product.accountNumberProxy,
  ];

  for (const candidate of candidates) {
    const id = readString(candidate);
    if (id) return id;
  }

  return null;
}

function readProductName(product: Record<string, unknown>): string {
  const candidates = [
    product.description,
    product.productDescription,
    product.displayName,
    product.productName,
    product.name,
    product.shortName,
  ];

  for (const candidate of candidates) {
    const name = readString(candidate);
    if (name) return name;
  }

  return "Unknown Card";
}

function readAccountKey(product: Record<string, unknown>): string | null {
  const candidates = [
    product.accountKey,
    product.account_key,
    product.accountKeyValue,
    product.account_key_value,
  ];

  for (const candidate of candidates) {
    const key = readString(candidate);
    if (key) return key;
  }

  return null;
}

function isCancelledProduct(product: Record<string, unknown>): boolean {
  const rawStatuses = [
    product.status,
    product.accountStatus,
    product.account_status,
    product.cardStatus,
    product.card_status,
  ];

  return rawStatuses
    .flatMap((status) => Array.isArray(status) ? status : [status])
    .some((status) => {
      const text = readString(status)?.toLowerCase();
      return Boolean(text && (text.includes("cancel") || text.includes("closed")));
    });
}

function normalizeProductRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => (
      typeof item === "object" && item !== null
    ));
  }

  if (!value || typeof value !== "object") return [];
  const root = value as Record<string, unknown>;
  const registry = root.registry as Record<string, unknown> | undefined;
  const registryTypes = registry?.types as Record<string, unknown> | undefined;
  const directTypes = root.types as Record<string, unknown> | undefined;
  const cardProducts = registryTypes?.CARD_PRODUCT ?? directTypes?.CARD_PRODUCT;

  if (Array.isArray(cardProducts)) {
    return cardProducts.filter((item): item is Record<string, unknown> => (
      typeof item === "object" && item !== null
    ));
  }

  const details = root.details as Record<string, unknown> | undefined;
  const detailTypes = details?.types as Record<string, unknown> | undefined;
  const detailCardProduct = detailTypes?.CARD_PRODUCT as Record<string, unknown> | undefined;
  const productsList = detailCardProduct?.productsList as Record<string, unknown> | undefined;

  if (productsList && typeof productsList === "object") {
    return Object.entries(productsList).flatMap(([id, product]) => {
      if (!product || typeof product !== "object") return [];
      return [{ id, ...(product as Record<string, unknown>) }];
    });
  }

  return [];
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

  const merged = productCards.map((card, index) => {
    const match =
      dashboardCards.find((candidate) => candidate.id === card.id)
      ?? dashboardCards.find((candidate) => candidate.accountKey && candidate.accountKey === card.accountKey)
      ?? dashboardCards.find((candidate) => (
        candidate.lastDigits
        && card.lastDigits
        && candidate.lastDigits.slice(-4) === card.lastDigits.slice(-4)
      ))
      ?? dashboardCards[index];

    if (!match) return card;

    return {
      id: card.id,
      name: isGenericAmexCardName(card.name) ? match.name : card.name,
      lastDigits: card.lastDigits ?? match.lastDigits,
      accountKey: card.accountKey ?? match.accountKey,
    };
  });

  for (const dashboardCard of dashboardCards) {
    const alreadyMerged = merged.some((card) => (
      card.id === dashboardCard.id
      || Boolean(card.accountKey && card.accountKey === dashboardCard.accountKey)
      || Boolean(card.lastDigits && card.lastDigits === dashboardCard.lastDigits)
    ));
    if (!alreadyMerged) merged.push(dashboardCard);
  }

  return merged;
}

/** Route an API call through the service worker's executeScript (MAIN world) */
function amexApiFetch(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<AmexApiResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ status: 0, data: null, error: "Timed out waiting for Amex API response" });
    }, 25000);

    chrome.runtime.sendMessage(
      { type: "AMEX_OFFERS_FETCH", url, method: options.method, headers: options.headers, body: options.body },
      (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
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
        const products = normalizeProductRecords(resp.products);
        const cards: AmexCard[] = products
          .filter((p) => {
            return Boolean(readProductId(p)) && !isCancelledProduct(p);
          })
          .map((p) => ({
            id: readProductId(p) ?? "",
            name: readProductName(p),
            lastDigits: readLastDigits(p),
            accountKey: readAccountKey(p),
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch("https://global.americanexpress.com/dashboard", {
      credentials: "include",
      headers: { accept: "text/html" },
      cache: "no-store",
      signal: controller.signal,
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
      const lastDigits = digitsMatch ? digitsMatch[1].slice(-5) : null;

      let accountKey: string | null = null;
      const keyMatch = decoded.match(new RegExp(`"accountToken","${accountToken}","accountKey","([^"]+)"`));
      if (keyMatch) accountKey = keyMatch[1];

      cards.push({ id: accountToken, name, lastDigits, accountKey });
    }

    return cards;
  } catch (e) {
    console.error("[NextCard Amex Offers] discoverCardsFromDashboard error:", e);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/** Try digitalData.products first, fall back to dashboard HTML parsing */
async function discoverCards(): Promise<AmexCard[]> {
  const productCards = await discoverCardsFromProducts();
  const dashboardCards = await discoverCardsFromDashboard();
  return mergeDiscoveredCards(productCards, dashboardCards);
}

// ── Offer Listing ──────────────────────────────────────────

function parseModernOffer(o: Record<string, unknown>): AmexOffer {
  return {
    offerId: (o.id ?? o.source_id ?? "") as string,
    name: (o.name ?? "Unknown") as string,
    status: (o.status ?? "ELIGIBLE") as string,
    shortDescription: (o.short_description ?? null) as string | null,
    category: (o.category ?? null) as string | null,
    expirationText: (o.expiry_date ?? null) as string | null,
    merchantUrl: ((o.cta as Record<string, unknown> | undefined)?.url ?? null) as string | null,
    merchantLogoUrl: (o.logo_url ?? null) as string | null,
    redemptionChannel: (() => {
      const types = (o.redemption_types as string[] | undefined) ?? [];
      const hasOnline = types.includes("ONLINE");
      const hasInStore = types.includes("IN_STORE");
      if (hasOnline && hasInStore) return "both" as const;
      if (hasOnline) return "online" as const;
      if (hasInStore) return "in_store" as const;
      return null;
    })(),
  };
}

function parseLegacyOffer(o: Record<string, unknown>): AmexOffer {
  return {
    offerId: (o.offerId ?? o.id ?? "") as string,
    name: (o.title ?? o.merchantName ?? "Unknown") as string,
    status: ((o.enrollmentDetails as Record<string, unknown> | undefined)?.status ?? "NOT_ENROLLED") as string,
    shortDescription: (o.shortDescription ?? null) as string | null,
    category: ((o.applicableCategories as Array<{ text: string }> | undefined)?.[0]?.text ?? null) as string | null,
    expirationText: ((o.expiration as { text: string } | undefined)?.text ?? null) as string | null,
    merchantUrl: ((o.longDescription as string | undefined)?.match(/(?:at|website)\s+(?:[\w.-]+\.(?:com|net|org|co|io|shop|store)\b)/i)?.[0]?.replace(/^(?:at|website)\s+/i, "") ?? null) as string | null,
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
  };
}

function normalizeAmexOfferStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toUpperCase();
}

function isAmexIssuerEnrolledStatus(status: string | null | undefined): boolean {
  return ["ENROLLED", "ADDED"].includes(normalizeAmexOfferStatus(status));
}

function isUnenrolledOffer(offer: AmexOffer): boolean {
  return !isAmexIssuerEnrolledStatus(offer.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLegacyOfferPage(
  data: Record<string, unknown>,
  sectionName: "recommendedOffers" | "addedToCard",
  pageKey: string,
): Record<string, unknown>[] | null {
  const section = data[sectionName];
  if (!isRecord(section) || !isRecord(section.offersList)) return null;

  const page = section.offersList[pageKey];
  if (!Array.isArray(page) || !page.every(isRecord)) return null;
  return page;
}

async function listOffersLegacyPage(
  cardId: string,
  locale: string,
  pageNumber: number,
): Promise<AmexOfferList | null> {
  const pageKey = `page${pageNumber}`;

  try {
    const resp = await amexApiFetch("https://functions.americanexpress.com/ReadOffersHubPresentation.web.v1", {
      method: "POST",
      headers: { accept: "application/json", "ce-source": "WEB", "content-type": "application/json" },
      body: JSON.stringify({
        accountNumberProxy: cardId,
        locale,
        offerPage: pageKey,
        requestType: "OFFERSHUB_LANDING",
      }),
    });

    if (resp.status !== 200 || !resp.data) return null;

    if (!isRecord(resp.data)) return null;
    const data = resp.data;
    const recList = readLegacyOfferPage(data, "recommendedOffers", pageKey);
    const addedList = readLegacyOfferPage(data, "addedToCard", pageKey);
    if (!recList || !addedList) return null;

    const all = [...recList, ...addedList];
    const offers = all
      .filter((o) => o.offerType === "MERCHANT")
      .map(parseLegacyOffer);
    if (offers.some((offer) => !offer.offerId)) return null;

    return {
      offers,
      eligibleCount: offers.filter(isUnenrolledOffer).length,
      complete: false,
      rawOfferCount: all.length,
    };
  } catch (e) {
    console.error(`[NextCard Amex Offers] listOffersLegacyPage(${pageKey}) error:`, e);
    return null;
  }
}

async function listOffersModern(cardId: string, locale: string): Promise<AmexOfferList | null> {
  try {
    const resp = await amexApiFetch("https://functions.americanexpress.com/ReadCardAccountOffersList.v1", {
      method: "POST",
      headers: {
        accept: "application/json",
        "ce-source": "offers.list",
        "content-type": "application/json",
        "one-data-correlation-id": randomCorrelationId(),
      },
      body: JSON.stringify({
        accountNumberProxy: cardId,
        locale,
        source: "STANDARD",
        typeOf: "MERCHANT",
        status: ["ELIGIBLE"],
        offerRequestType: "LIST",
        userOffset: getUserOffset(),
      }),
    });

    if (resp.status !== 200 || !resp.data) return null;

    const data = resp.data as Record<string, unknown>;
    const all = (data.offers ?? []) as Record<string, unknown>[];
    const eligibleCount = (data.count as Record<string, unknown> | undefined)?.eligible;

    if (all.length === 0) {
      return {
        offers: [],
        eligibleCount: typeof eligibleCount === "number" ? eligibleCount : null,
        complete: false,
      };
    }

    return {
      offers: all
        .filter((o) => o.type === "MERCHANT")
        .map(parseModernOffer),
      eligibleCount: typeof eligibleCount === "number" ? eligibleCount : null,
      complete: false,
    };
  } catch (e) {
    console.error("[NextCard Amex Offers] listOffersModern error:", e);
    return null;
  }
}

async function listOffers(cardId: string, locale = "en-US"): Promise<AmexOfferList | null> {
  const legacyOffers = await listOffersLegacyPage(cardId, locale, 1);
  if (legacyOffers && legacyOffers.offers.length > 0) return legacyOffers;
  return await listOffersModern(cardId, locale);
}

async function listAllOffers(cardId: string, locale = "en-US"): Promise<AmexOfferList | null> {
  const firstPage = await listOffersLegacyPage(cardId, locale, 1);
  if (!firstPage) {
    return await listOffersModern(cardId, locale);
  }
  if (firstPage.rawOfferCount === 0) {
    return { ...firstPage, complete: true };
  }

  const offersById = new Map<string, AmexOffer>();
  for (const offer of firstPage.offers) {
    if (offer.offerId) offersById.set(offer.offerId, offer);
  }

  for (let pageNumber = 2; pageNumber <= MAX_AMEX_OFFER_PAGES; pageNumber += 1) {
    const page = await listOffersLegacyPage(cardId, locale, pageNumber);
    if (!page) {
      return {
        offers: Array.from(offersById.values()),
        eligibleCount: Array.from(offersById.values()).filter(isUnenrolledOffer).length,
        complete: false,
      };
    }
    if (page.rawOfferCount === 0) {
      const offers = Array.from(offersById.values());
      return {
        offers,
        eligibleCount: offers.filter(isUnenrolledOffer).length,
        complete: true,
      };
    }

    let foundNewOffer = false;
    for (const offer of page.offers) {
      if (!offer.offerId || offersById.has(offer.offerId)) continue;
      offersById.set(offer.offerId, offer);
      foundNewOffer = true;
    }

    // A page containing only non-merchant offers is valid but has nothing to
    // sync. Keep paging; only an actually empty raw page ends the snapshot.
    if (page.offers.length > 0 && !foundNewOffer) {
      const offers = Array.from(offersById.values());
      return {
        offers,
        eligibleCount: offers.filter(isUnenrolledOffer).length,
        complete: false,
      };
    }
  }

  const offers = Array.from(offersById.values());
  return {
    offers,
    eligibleCount: offers.filter(isUnenrolledOffer).length,
    complete: false,
  };
}

async function readOfferDetails(cardId: string, offerId: string, locale: string): Promise<AmexOffer | null> {
  try {
    const resp = await amexApiFetch("https://functions.americanexpress.com/ReadCardAccountOffersList.v1", {
      method: "POST",
      headers: {
        accept: "application/json",
        "ce-source": "offers.details",
        "content-type": "application/json",
        "one-data-correlation-id": randomCorrelationId(),
      },
      body: JSON.stringify({
        accountNumberProxy: cardId,
        identifier: offerId,
        locale,
        source: "STANDARD",
        identifierType: "OFFER",
        offerRequestType: "DETAILS",
        userOffset: getUserOffset(),
        requestDateTimeWithOffset: formatRequestDateTime(),
      }),
    });

    if (resp.status !== 200 || !resp.data) return null;
    return parseModernOffer(resp.data as Record<string, unknown>);
  } catch (e) {
    console.error("[NextCard Amex Offers] readOfferDetails error:", e);
    return null;
  }
}

// ── Enrollment ─────────────────────────────────────────────

let cancelled = false;

// Amex starts returning transient failures if enrollment bursts too quickly.
const ENROLL_BASE_DELAY_MS = 900;
const ENROLL_JITTER_MIN_MS = 350;
const ENROLL_JITTER_MAX_MS = 1200;
const ENROLL_PAUSE_THRESHOLD = 25;
const ENROLL_PAUSE_DELAY_MS = 10000;
const OFFER_BATCH_REFETCH_DELAY_MS = 4500;
const MAX_EMPTY_BATCH_POLLS = 4;
const MAX_STALE_BATCH_POLLS = 4;
const RATE_LIMIT_COOLDOWN_MS = 45000;
const MAX_RATE_LIMIT_RETRIES = 3;
let enrollRequestsSincePause = 0;

function enrollJitter(): number {
  return Math.floor(Math.random() * (ENROLL_JITTER_MAX_MS - ENROLL_JITTER_MIN_MS + 1)) + ENROLL_JITTER_MIN_MS;
}

function sendProgress(data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type: "AMEX_OFFERS_PROGRESS", ...data }).catch(() => {});
}

/** Enroll a single offer via MAIN world executeScript */
function enrollSingleOffer(cardId: string, offerId: string, locale: string): Promise<AmexEnrollResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "AMEX_OFFERS_ENROLL_ONE", cardId, offerId, locale },
      (resp) => {
        if (chrome.runtime.lastError || !resp) resolve({ result: "failed", error: chrome.runtime.lastError?.message });
        else resolve({ ...resp, result: resp.result ?? "failed" });
      },
    );
  });
}

function isRateLimitLike(result: AmexEnrollResult): boolean {
  if (result.status === 429 || result.status === 403 || result.status === 503 || result.status === 0) return true;
  const text = [
    result.error,
    result.message,
    result.explanationCode,
    result.purpose,
  ].filter(Boolean).join(" ");
  return /abort|timeout|rate|limit|too many|temporar|unavailable/i.test(text);
}

function formatEnrollError(result: AmexEnrollResult): string | null {
  const pieces = [
    result.status ? `HTTP ${result.status}` : null,
    typeof result.explanationCode === "string" ? result.explanationCode : null,
    typeof result.purpose === "string" ? result.purpose : null,
    typeof result.message === "string" ? result.message : null,
    typeof result.error === "string" ? result.error : null,
  ].filter(Boolean);
  return pieces.length > 0 ? pieces.join(" - ") : null;
}

async function runEnrollment(cardId: string, locale: string) {
  cancelled = false;
  enrollRequestsSincePause = 0;

  let totalAdded = 0;
  let totalAlreadyAdded = 0;
  let totalFailed = 0;
  let totalEligible = 0;
  let round = 0;
  const MAX_ROUNDS = 50;
  const enrolledOffers: AmexOffer[] = [];
  const enrolledOfferIds = new Set<string>();
  const failedOfferIds = new Set<string>();
  let emptyBatchPolls = 0;
  let staleBatchPolls = 0;
  let lastError: string | null = null;
  let sessionExpired = false;

  while (round < MAX_ROUNDS && !cancelled && !sessionExpired) {
    round++;
    sendProgress({ status: "fetching", round, added: totalAdded });

    const offerList = await listOffers(cardId, locale);
    if (!offerList) break;

    const eligible = offerList.offers.filter((o) => (
      o.offerId
      && isUnenrolledOffer(o)
      && !enrolledOfferIds.has(o.offerId)
      && !failedOfferIds.has(o.offerId)
    ));

    totalEligible = Math.max(
      totalEligible,
      offerList.eligibleCount ?? 0,
      enrolledOfferIds.size + failedOfferIds.size + eligible.length,
    );

    if (eligible.length === 0) {
      const completedOfferCount = enrolledOfferIds.size + failedOfferIds.size;
      if ((offerList.eligibleCount ?? 0) > completedOfferCount && emptyBatchPolls < MAX_EMPTY_BATCH_POLLS) {
        emptyBatchPolls++;
        sendProgress({ status: "checking_new", round, added: totalAdded, total: totalEligible });
        await delay(OFFER_BATCH_REFETCH_DELAY_MS + enrollJitter());
        continue;
      }
      break;
    }

    sendProgress({ status: "enrolling", round, added: totalAdded, total: totalEligible });

    let roundAdded = 0;

    for (const offer of eligible) {
      if (cancelled) break;

      const offerForSync = offer;
      let result = await enrollSingleOffer(cardId, offerForSync.offerId, locale);
      let rateLimitRetries = 0;

      while (result.result === "failed" && isRateLimitLike(result) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES && !cancelled) {
        rateLimitRetries++;
        lastError = formatEnrollError(result);
        sendProgress({
          status: "cooling_down",
          added: totalAdded,
          skipped: totalAlreadyAdded,
          failed: totalFailed,
          round,
          total: totalEligible,
          waitSeconds: Math.round(RATE_LIMIT_COOLDOWN_MS / 1000),
          error: lastError,
        });
        await delay(RATE_LIMIT_COOLDOWN_MS + enrollJitter());
        result = await enrollSingleOffer(cardId, offerForSync.offerId, locale);
      }

      if (result.result === "added" || result.result === "skipped") {
        if (!enrolledOfferIds.has(offerForSync.offerId)) {
          enrolledOfferIds.add(offerForSync.offerId);
          totalAdded++;
          roundAdded++;
          enrolledOffers.push(offerForSync);
        }
        if (result.result === "skipped") totalAlreadyAdded++;
      } else {
        lastError = formatEnrollError(result);
        if (result.status === 401) {
          sessionExpired = true;
          lastError = "Your Amex session expired. Log in to Amex, then run again.";
          console.warn("[NextCard Amex Offers] Amex session expired during enrollment");
        } else {
          totalFailed++;
          failedOfferIds.add(offerForSync.offerId);
        }
        console.warn("[NextCard Amex Offers] Amex rejected enrollment:", {
          offerId: offerForSync.offerId,
          error: lastError,
        });
      }

      sendProgress({ added: totalAdded, skipped: totalAlreadyAdded, failed: totalFailed, round, total: totalEligible, error: lastError });

      if (sessionExpired) break;

      // Proactive rate limiting
      enrollRequestsSincePause++;
      if (enrollRequestsSincePause >= ENROLL_PAUSE_THRESHOLD) {
        await delay(ENROLL_PAUSE_DELAY_MS + enrollJitter());
        enrollRequestsSincePause = 0;
      } else {
        await delay(ENROLL_BASE_DELAY_MS + enrollJitter());
      }
    }

    if (sessionExpired) break;

    if (roundAdded === 0) {
      const completedOfferCount = enrolledOfferIds.size + failedOfferIds.size;
      if ((offerList.eligibleCount ?? totalEligible) > completedOfferCount && staleBatchPolls < MAX_STALE_BATCH_POLLS) {
        staleBatchPolls++;
        sendProgress({ status: "checking_new", round, added: totalAdded, total: totalEligible });
        await delay(OFFER_BATCH_REFETCH_DELAY_MS + enrollJitter());
        continue;
      }
      break;
    }

    emptyBatchPolls = 0;
    staleBatchPolls = 0;

    if (round < MAX_ROUNDS && !cancelled) {
      sendProgress({ status: "checking_new", round, added: totalAdded });
      await delay(OFFER_BATCH_REFETCH_DELAY_MS + enrollJitter());
    }
  }

  chrome.runtime.sendMessage({
    type: "AMEX_OFFERS_COMPLETE",
    added: totalAdded,
    skipped: totalAlreadyAdded,
    failed: totalFailed,
    lastError,
    sessionExpired,
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
      const probes = await Promise.all(cards.map((c) => listAllOffers(c.id).catch(() => null)));
      const offerCounts: Record<string, number> = {};
      for (let i = 0; i < cards.length; i++) {
        const offerList = probes[i];
        const offers = offerList?.offers ?? [];
        const eligible = offers.filter(isUnenrolledOffer);
        if (offerList) offerCounts[cards[i].id] = offerList.eligibleCount ?? eligible.length;
        console.info("[NextCard Amex Offers] card discovery summary:", {
          cardName: cards[i].name,
          lastDigits: cards[i].lastDigits,
          observed: offers.length,
          availableToActivate: offerCounts[cards[i].id] ?? 0,
          alreadyActivated: offers.length - eligible.length,
          probeFailed: offerList === null,
          snapshotComplete: offerList?.complete ?? false,
        });

        if (offerList && (offers.length > 0 || offerList.complete)) {
          chrome.runtime.sendMessage({
            type: "AMEX_OFFERS_DETECTED",
            cardId: cards[i].id,
            cardName: cards[i].name,
            cardLastDigits: cards[i].lastDigits,
            snapshotComplete: offerList.complete,
            snapshotCapturedAt: offerList.complete ? new Date().toISOString() : undefined,
            observedIssuerOfferIds: offerList.complete
              ? offers.map((offer) => offer.offerId).filter(Boolean)
              : undefined,
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
              status: isUnenrolledOffer(o) ? "detected" : "enrolled",
            })),
          }).catch(() => {});
        }
      }
      sendResponse({
        type: "AMEX_OFFERS_READY",
        cards: cards.map((c) => ({ id: c.id, name: c.name, lastDigits: c.lastDigits, accountKey: c.accountKey, locale: "en-US" })),
        offerCounts,
        offerProbeError: probes.every((probe) => probe === null) ? "offer_probe_failed" : undefined,
        error: undefined,
      });
    })();
    return true;
  }

  if (message.type === "AMEX_OFFERS_RUN") {
    selectedCardName = (message.cardName as string) ?? "";
    selectedCardLastDigits = (message.cardLastDigits as string) ?? null;
    runEnrollment(message.cardId, normalizeLocale(message.locale));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "AMEX_OFFERS_STOP") {
    cancelled = true;
    sendResponse({ ok: true });
    return true;
  }
});
