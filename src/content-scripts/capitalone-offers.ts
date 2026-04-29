/**
 * Capital One Shopping Offers — pull available shopping/merchant offers.
 *
 * Capital One renders offers through the enterprise dynamic-tile platform,
 * not a classic "activate this offer" API. We therefore sync these as
 * detected offers per eligible card/account reference.
 */

interface CapitalOneCard {
  id: string;
  name: string;
  lastDigits: string | null;
  productId: string | null;
  category: string | null;
  currency: string | null;
}

interface CapitalOneOffer {
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
}

interface CapitalOneDiscovery {
  cards: CapitalOneCard[];
  offersByCard: Record<string, CapitalOneOffer[]>;
  redirectUrl?: string | null;
}

const CAPITALONE_OFFERS_BOOTSTRAPPED_KEY = "__nextcardCapitalOneOffersBootstrapped";
const FEED_MAX_PAGES = 1;
const FEED_PAGE_DELAY_MS = 650;
const FEED_CARD_DELAY_MS = 1_500;
const FEED_RATE_LIMIT_RETRY_BASE_MS = 8_000;
const FEED_RATE_LIMIT_RETRY_MAX_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function getOptionMap(value: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(value)) return map;

  for (const option of value) {
    if (!isRecord(option)) continue;
    const key = readString(option.key);
    const optionValue = readString(option.value);
    if (key && optionValue) map[key] = optionValue;
  }

  return map;
}

function getLabelMap(value: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(value)) return map;

  for (const label of value) {
    if (!isRecord(label)) continue;
    const key = readString(label.key);
    const text = readString(label.text);
    if (key && text) map[key] = text;
  }

  return map;
}

function getActionUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;

  for (const action of value) {
    if (!isRecord(action) || !Array.isArray(action.additionalInputs)) continue;
    for (const input of action.additionalInputs) {
      if (!isRecord(input)) continue;
      if (readString(input.key)?.toUpperCase() !== "URL") continue;
      const url = readString(input.value);
      if (url) return url;
    }
  }

  return null;
}

function rewardFromText(text: string | null): Pick<CapitalOneOffer, "rewardType" | "rewardAmount" | "rewardCurrency"> {
  if (!text) {
    return { rewardType: null, rewardAmount: null, rewardCurrency: null };
  }

  const multiplier = text.match(/(?:up to\s*)?(\d+(?:\.\d+)?)\s*x\s*(?:miles|points)?/i);
  if (multiplier) {
    return {
      rewardType: "points",
      rewardAmount: Number(multiplier[1]),
      rewardCurrency: /point/i.test(text) ? "points" : "miles",
    };
  }

  const percentage = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percentage) {
    return { rewardType: "percentage", rewardAmount: Number(percentage[1]), rewardCurrency: "cash" };
  }

  const cash = text.match(/\$(\d+(?:\.\d+)?)/);
  if (cash) {
    return { rewardType: "flat_cash", rewardAmount: Number(cash[1]), rewardCurrency: "cash" };
  }

  if (/miles/i.test(text)) {
    return { rewardType: "points", rewardAmount: null, rewardCurrency: "miles" };
  }

  return { rewardType: null, rewardAmount: null, rewardCurrency: null };
}

type MerchantCategory =
  | "DINING"
  | "FOOD"
  | "GROCERY"
  | "TRAVEL"
  | "GAS"
  | "ENTERTAINMENT"
  | "HEALTH"
  | "HOME"
  | "SHOPPING";

const CATEGORY_RULES: Array<{
  category: MerchantCategory;
  domains?: string[];
  keywords: string[];
}> = [
  {
    category: "DINING",
    domains: [
      "doordash.com",
      "grubhub.com",
      "ubereats.com",
      "starbucks.com",
      "dunkindonuts.com",
      "chipotle.com",
      "panerabread.com",
      "dominos.com",
      "papajohns.com",
      "pizzahut.com",
      "subway.com",
    ],
    keywords: ["restaurant", "restaurants", "cafe", "coffee", "pizza", "burger", "grill", "kitchen", "bakery", "taco", "sushi"],
  },
  {
    category: "GROCERY",
    domains: [
      "instacart.com",
      "kroger.com",
      "safeway.com",
      "wholefoodsmarket.com",
      "aldi.us",
      "traderjoes.com",
      "freshdirect.com",
      "gopuff.com",
    ],
    keywords: ["grocery", "groceries", "supermarket", "market", "fresh", "foods"],
  },
  {
    category: "TRAVEL",
    domains: [
      "airbnb.com",
      "booking.com",
      "expedia.com",
      "hotels.com",
      "vrbo.com",
      "marriott.com",
      "hilton.com",
      "hyatt.com",
      "ihg.com",
      "delta.com",
      "united.com",
      "aa.com",
      "southwest.com",
    ],
    keywords: ["hotel", "hotels", "resort", "travel", "airlines", "airways", "flight", "cruise", "vacation", "rental car"],
  },
  {
    category: "GAS",
    domains: ["shell.com", "chevron.com", "exxon.com", "bp.com", "sunoco.com", "circlek.com", "speedway.com"],
    keywords: ["gas", "fuel", "auto", "automotive", "car wash", "parking"],
  },
  {
    category: "ENTERTAINMENT",
    domains: [
      "ticketmaster.com",
      "stubhub.com",
      "fandango.com",
      "netflix.com",
      "hulu.com",
      "spotify.com",
      "audible.com",
      "disneyplus.com",
    ],
    keywords: ["tickets", "movie", "movies", "streaming", "music", "games", "entertainment", "theater", "concert"],
  },
  {
    category: "HEALTH",
    domains: ["cvs.com", "walgreens.com", "riteaid.com", "goli.com", "vitacost.com", "iherb.com"],
    keywords: ["pharmacy", "health", "wellness", "vitamin", "fitness", "medical", "beauty"],
  },
  {
    category: "HOME",
    domains: ["homedepot.com", "lowes.com", "wayfair.com", "ikea.com", "overstock.com", "article.com"],
    keywords: ["home", "furniture", "garden", "mattress", "decor", "appliance", "hardware"],
  },
  {
    category: "FOOD",
    domains: ["hellofresh.com", "blueapron.com", "factor75.com", "daily-harvest.com", "nuts.com"],
    keywords: ["meal", "snack", "wine", "tea", "coffee", "beverage", "food"],
  },
];

function inferCategoryFromMerchant(merchantTld: string, merchantName: string): MerchantCategory {
  const normalizedDomain = merchantTld.toLowerCase().replace(/^www\./, "");
  const searchableName = merchantName.toLowerCase();

  for (const rule of CATEGORY_RULES) {
    if (rule.domains?.some((domain) => normalizedDomain === domain || normalizedDomain.endsWith(`.${domain}`))) {
      return rule.category;
    }

    if (rule.keywords.some((keyword) => searchableName.includes(keyword))) {
      return rule.category;
    }
  }

  return "SHOPPING";
}

function readCategory(item: Record<string, unknown>, badge: string | null, merchantTld: string, merchantName: string): string {
  const candidates = [
    badge,
    readString(item.category),
    readString(item.categoryName),
    readString(item.merchantCategory),
    readString(item.merchantCategoryName),
    readString(item.offerCategory),
    readString(item.promotionType),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (/^(standard|default|none)$/i.test(candidate)) continue;
    return candidate;
  }

  return inferCategoryFromMerchant(merchantTld, merchantName);
}

function redemptionChannelFromText(text: string | null): CapitalOneOffer["redemptionChannel"] {
  if (!text) return null;
  const normalized = text.toLowerCase();
  const hasOnline = normalized.includes("online");
  const hasStore = normalized.includes("store") || normalized.includes("in-store") || normalized.includes("in store");
  if (hasOnline && hasStore) return "both";
  if (hasOnline) return "online";
  if (hasStore) return "in_store";
  return null;
}

function prettifyDomain(domain: string): string {
  const base = domain
    .replace(/^www\./i, "")
    .replace(/\.(?:com|net|org|co|io|shop|store|travel|us)$/i, "")
    .replace(/[-_]+/g, " ");
  return base.replace(/\b\w/g, (char) => char.toUpperCase());
}

function stablePart(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function stableOfferId(merchantUrl: string, offerValue: string, channel: CapitalOneOffer["redemptionChannel"]): string {
  return [
    stablePart(merchantUrl),
    stablePart(offerValue),
    channel ?? "any",
  ].join(":");
}

function merchantUrlFromName(merchantName: string, elementName: string | null): string | null {
  const domainMatch = elementName?.match(/\b([a-z0-9-]+\.(?:com|net|org|co|io|shop|store|travel))\b/i);
  if (domainMatch) return domainMatch[1].toLowerCase();

  if (/\.[a-z]{2,}$/i.test(merchantName)) {
    return merchantName.toLowerCase();
  }

  return null;
}

function collectText(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" && value.trim()) {
    out.push(value.trim());
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return out;
  }

  if (isRecord(value)) {
    for (const child of Object.values(value)) collectText(child, out);
  }

  return out;
}

function offerFromNode(node: Record<string, unknown>): CapitalOneOffer | null {
  const optionMap = getOptionMap(node.options);
  const type = readString(node.type);
  const elementName =
    optionMap["analytics.pageImpression.uiInteractionElementName"]
    ?? optionMap["analytics.action.linkClick.uiInteractionElementName"]
    ?? null;
  const merchantName =
    optionMap["analytics.pageImpression.merchantName"]
    ?? optionMap["analytics.action.linkClick.merchantName"]
    ?? null;

  const looksLikeOffer =
    merchantName
    || elementName?.toLowerCase().includes("shopping_offer")
    || type?.toLowerCase().includes("offer");

  if (!looksLikeOffer) return null;

  const elementParts = elementName?.split(":").map((part) => part.trim()).filter(Boolean) ?? [];
  const tileIndex = elementParts.findIndex((part) => part.toLowerCase().includes("shopping_offer"));
  const merchantFromElement = tileIndex >= 0 ? elementParts[tileIndex + 1] : null;
  const valueFromElement = tileIndex >= 0 ? elementParts[tileIndex + 2] : null;
  const channelFromElement = tileIndex >= 0 ? elementParts[tileIndex + 3] : null;

  const allText = collectText(node);
  const fallbackMerchant = allText.find((text) => /^[A-Z0-9][\w '&.-]{1,60}$/i.test(text) && !/offer|earn|online|miles|cash|points|view/i.test(text));
  const fallbackValue = allText.find((text) => /(?:\d+\s*x|\d+\s*%|\$\d+|miles|points|cash back)/i.test(text));

  const name = merchantName ?? merchantFromElement ?? fallbackMerchant;
  if (!name) return null;

  const offerValue = valueFromElement ?? fallbackValue ?? null;
  const reward = rewardFromText(offerValue);
  const channel = redemptionChannelFromText(channelFromElement ?? elementName ?? null);

  return {
    issuerOfferId: elementName ?? `${name}:${offerValue ?? "offer"}`,
    merchantName: name,
    offerValue,
    category: null,
    expirationDate: null,
    rewardType: reward.rewardType,
    rewardAmount: reward.rewardAmount,
    rewardCurrency: reward.rewardCurrency,
    maxReward: null,
    minSpend: null,
    merchantUrl: merchantUrlFromName(name, elementName),
    merchantLogoUrl: collectText(node).find((text) => /^https?:\/\/.+\.(?:png|jpe?g|webp|avif)(?:\?|$)/i.test(text)) ?? null,
    redemptionChannel: channel,
  };
}

function offerFromFeedItem(item: Record<string, unknown>, card: CapitalOneCard): CapitalOneOffer | null {
  const merchantTld = readString(item.merchantTLD);
  const id = readString(item.id);
  const buttonText = readString(item.buttonText);
  if (!merchantTld || !id || !buttonText) return null;

  const reward = rewardFromText(buttonText);
  const imageSrc = readString(item.imageSrc);
  const channelText = readString(item.text);
  const badge = isRecord(item.badge) ? readString(item.badge.text) : null;
  const redemptionChannel = redemptionChannelFromText(channelText);
  const merchantName = prettifyDomain(merchantTld);

  return {
    issuerOfferId: stableOfferId(merchantTld, buttonText, redemptionChannel),
    merchantName,
    offerValue: buttonText,
    category: readCategory(item, badge, merchantTld, merchantName),
    expirationDate: null,
    rewardType: reward.rewardType,
    rewardAmount: reward.rewardAmount,
    rewardCurrency: reward.rewardCurrency ?? card.currency,
    maxReward: null,
    minSpend: null,
    merchantUrl: merchantTld,
    merchantLogoUrl: imageSrc,
    redemptionChannel,
  };
}

function extractOffers(payload: unknown): CapitalOneOffer[] {
  const offers: CapitalOneOffer[] = [];
  const seen = new Set<string>();

  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!isRecord(value)) return;

    const offer = offerFromNode(value);
    if (offer && !seen.has(offer.issuerOfferId)) {
      seen.add(offer.issuerOfferId);
      offers.push(offer);
    }

    for (const child of Object.values(value)) visit(child);
  }

  visit(payload);
  return offers;
}

function extractFeedOffers(payload: unknown, card: CapitalOneCard): CapitalOneOffer[] {
  const offers: CapitalOneOffer[] = [];
  const seen = new Set<string>();

  function visit(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!isRecord(value)) return;

    const offer = offerFromFeedItem(value, card);
    if (offer && !seen.has(offer.issuerOfferId)) {
      seen.add(offer.issuerOfferId);
      offers.push(offer);
    }

    for (const child of Object.values(value)) visit(child);
  }

  visit(payload);
  return offers;
}

async function fetchJson(url: string, options: RequestInit = {}): Promise<unknown | null> {
  try {
    const resp = await fetch(url, {
      ...options,
      credentials: "include",
      headers: {
        Accept: "application/json;v=1",
        "Content-Type": "application/json;v=1",
        "Channel-Type": "Web",
        ...(options.headers ?? {}),
      },
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch (e) {
    console.error("[NextCard Capital One Offers] fetchJson error:", e);
    return null;
  }
}

async function discoverCards(): Promise<CapitalOneCard[]> {
  const data = await fetchJson("/web-api/protected/636178/customer-accounts?density=4&retrieveBusinessName=false&versionUpgrade=true");
  if (!isRecord(data) || !Array.isArray(data.entries)) return [];

  return data.entries
    .filter((entry): entry is Record<string, unknown> => {
      if (!isRecord(entry)) return false;
      const product = isRecord(entry.product) ? entry.product : {};
      const category = (
        readString(product.productSubCategory)
        ?? readString(product.productTypeCode)
        ?? readString(entry.category)
      )?.toUpperCase();
      const status = readString(entry.accountStatus)?.toLowerCase();
      return ["CC", "CREDIT_CARD", "CREDITCARD"].includes(category ?? "") && status !== "closed" && status !== "charged off";
    })
    .map((entry) => {
      const product = isRecord(entry.product) ? entry.product : {};
      const category = readString(product.productSubCategory)
        ?? readString(product.productTypeCode)
        ?? readString(entry.category);
      const name =
        readString(entry.accountNickname)
        ?? readString(product.productName)
        ?? readString(entry.displayName)
        ?? "Capital One Card";
      const displayNumber = readString(entry.displayAccountNumber) ?? readString(entry.accountNumber);
      return {
        id: readString(entry.accountReferenceId) ?? "",
        name,
        lastDigits: displayNumber ? displayNumber.replace(/\D/g, "").slice(-4) || null : null,
        productId: readString(product.productId),
        category,
        currency: "miles",
      };
    })
    .filter((card) => card.id);
}

async function discoverEligibleCards(): Promise<CapitalOneCard[]> {
  const [cards, eligibility] = await Promise.all([
    discoverCards(),
    fetchJson("/web-api/private/2151863/shopping/eligibility", {
      headers: { Accept: "application/json;v=1" },
    }),
  ]);

  if (!isRecord(eligibility) || !Array.isArray(eligibility.eligibleAccounts)) {
    return cards;
  }

  const eligible = new Set(
    eligibility.eligibleAccounts
      .filter(isRecord)
      .filter((entry) => {
        const placements = entry.eligiblePlacements;
        return !Array.isArray(placements) || placements.includes("l2") || placements.includes("l1");
      })
      .map((entry) => readString(entry.accountReferenceId))
      .filter((id): id is string => !!id),
  );

  return cards.filter((card) => eligible.has(card.id));
}

function buildTileRequest(card: CapitalOneCard) {
  return {
    experienceId: "shopping_offers",
    accountReferenceIds: [card.id],
    clientCapabilities: {
      clientName: "EASE Web",
      clientVersion: `PROD_${new Date().toISOString()}`,
      channelCategory: "Web",
      tileElements: ["type", "style", "id", "tiles", "labels", "options", "actions", "images", "questions"],
      actionTypes: ["OPEN_EXTERNAL_URL", "EMIT_LOCAL_EVENT", "SIGNAL_SUCCESS_ADJUSTMENTS", "ROUTE_TO", "SUBMIT_DATA", "FETCH_DATA", "FIRE_FORGET"],
      localEvents: ["FETCH_EXPERIENCE", "SUBMIT_FORM_AND_FETCH_EXPERIENCE", "CLOSE"],
    },
    placementId: undefined,
    analyticsPlacement: "L2",
    featureKey: "Merchant Offers Widget",
    featureName: "MerchantOffersWidget",
    lob: "card",
    clientContext: [
      { key: "subExperienceId", value: "l2_widget", type: "string" },
      { key: "productId", value: card.productId ?? "", type: "string" },
      { key: "productCategory", value: card.category ?? "CC", type: "string" },
      { key: "contentSlug", value: "ease-web-l2", type: "string" },
    ],
    featureCapabilities: { localEvents: [] },
  };
}

function buildHomeTileRequest(card: CapitalOneCard) {
  return {
    experienceId: "shopping_offers",
    accountReferenceIds: [card.id],
    clientCapabilities: buildTileRequest(card).clientCapabilities,
    clientContext: [
      { key: "subExperienceId", value: "web_home_widget", type: "string" },
      { key: "productId", value: card.productId ?? "", type: "string" },
      { key: "productCategory", value: card.category ?? "CC", type: "string" },
      { key: "contentSlug", value: "ease-web-l1", type: "string" },
    ],
  };
}

function findCapitalOneOffersUrl(payload: unknown): string | null {
  let found: string | null = null;

  function visit(value: unknown) {
    if (found) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    if (!isRecord(value)) return;

    const labels = getLabelMap(value.labels);
    const url = getActionUrl(value.actions);
    if (url?.startsWith("https://capitaloneoffers.com/") && /view all offers/i.test(labels.button ?? "")) {
      found = url;
      return;
    }

    if (url?.startsWith("https://capitaloneoffers.com/feed")) {
      found = url;
      return;
    }

    for (const child of Object.values(value)) visit(child);
  }

  visit(payload);
  return found;
}

async function getOffersFeedUrl(): Promise<string | null> {
  const cards = await discoverEligibleCards();
  const card = cards[0];
  if (!card) return null;

  const data = await fetchJson(
    "/web-api/protected/223473/enterprise/dynamic-experiences/experience-hub/retrieve-tile-definition/shopping_offers",
    {
      method: "POST",
      body: JSON.stringify(buildHomeTileRequest(card)),
      headers: {
        Accept: "application/json;v=1",
        "Content-Type": "application/json",
        "Channel-Type": "WEB",
        "Accept-Language": "en-US",
      },
    },
  );

  return findCapitalOneOffersUrl(data);
}

async function listOffers(card: CapitalOneCard): Promise<CapitalOneOffer[]> {
  const data = await fetchJson(
    "/web-api/protected/223473/enterprise/dynamic-experiences/experience-hub/retrieve-tile-definition/shopping_offers",
    {
      method: "POST",
      body: JSON.stringify(buildTileRequest(card)),
    },
  );

  if (!data) return [];
  return extractOffers(data);
}

async function discoverFeedCards(): Promise<CapitalOneCard[]> {
  const data = await fetchJson("/user-accounts", {
    headers: { Accept: "application/json" },
  });
  if (!Array.isArray(data)) return [];

  return data
    .filter(isRecord)
    .map((entry) => ({
      id: readString(entry.accountReferenceId) ?? "",
      name: readString(entry.productName) ?? "Capital One Card",
      lastDigits: readString(entry.last4),
      productId: readString(entry.productId),
      category: "CC",
      currency: readString(entry.accountCurrency),
    }))
    .filter((card) => card.id);
}

function getFeedContext() {
  const url = new URL(window.location.href);
  return {
    viewInstanceId: url.searchParams.get("viewInstanceId") ?? "",
    contentSlug: url.searchParams.get("initialContentSlug") ?? url.searchParams.get("contentSlug") ?? "ease-web-l1",
  };
}

class CapitalOneFeedFetchError extends Error {
  status: number;

  constructor(status: number, statusText: string) {
    super(`Capital One feed request failed: ${status} ${statusText}`);
    this.status = status;
  }
}

async function fetchFeedPage(card: CapitalOneCard, cursor: string | null): Promise<{ offers: CapitalOneOffer[]; cursor: string | null }> {
  const { viewInstanceId, contentSlug } = getFeedContext();
  const params = new URLSearchParams({
    numberOfColumnsInGrid: "5",
    viewInstanceId,
    contentSlug,
  });
  if (cursor) params.set("cursor", cursor);

  const resp = await fetch(`/feed/${encodeURIComponent(card.id)}?${params.toString()}`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new CapitalOneFeedFetchError(resp.status, resp.statusText);

  const payload = await resp.json().catch(() => null);

  if (!isRecord(payload)) return { offers: [], cursor: null };

  return {
    offers: extractFeedOffers(payload.data, card),
    cursor: readString(payload.cursor),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listFeedOffers(
  card: CapitalOneCard,
  progress?: { cardIndex: number; cardTotal: number },
): Promise<CapitalOneOffer[]> {
  const offers: CapitalOneOffer[] = [];
  const seenOffers = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < FEED_MAX_PAGES; page++) {
    if (page > 0) await delay(FEED_PAGE_DELAY_MS);
    let result: { offers: CapitalOneOffer[]; cursor: string | null } | null = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        result = await fetchFeedPage(card, cursor);
        break;
      } catch (error) {
        if (!(error instanceof CapitalOneFeedFetchError) || error.status !== 429 || attempt === 7) {
          console.error("[NextCard Capital One Offers] feed request failed:", error);
          return offers;
        }

        const waitMs = Math.min(FEED_RATE_LIMIT_RETRY_MAX_MS, FEED_RATE_LIMIT_RETRY_BASE_MS * (attempt + 1));
        sendProgress({
          phase: "discovering",
          statusText: "Waiting before continuing...",
          cardName: card.name,
          cardIndex: progress?.cardIndex ?? 0,
          cardTotal: progress?.cardTotal ?? 1,
          page: page + 1,
          offersFound: offers.length,
          progress: Math.min(
            95,
            Math.round((((progress?.cardIndex ?? 0) + Math.min(page + 1, FEED_MAX_PAGES) / FEED_MAX_PAGES) / (progress?.cardTotal ?? 1)) * 100),
          ),
        });
        await delay(waitMs);
      }
    }

    if (!result) return offers;
    let newOffers = 0;

    for (const offer of result.offers) {
      if (seenOffers.has(offer.issuerOfferId)) continue;
      seenOffers.add(offer.issuerOfferId);
      offers.push(offer);
      newOffers++;
    }

    if (progress) {
      sendProgress({
        phase: "discovering",
        cardName: card.name,
        cardIndex: progress.cardIndex,
        cardTotal: progress.cardTotal,
        page: page + 1,
        offersFound: offers.length,
        progress: Math.min(
          95,
          Math.round(((progress.cardIndex + Math.min(page + 1, FEED_MAX_PAGES) / FEED_MAX_PAGES) / progress.cardTotal) * 100),
        ),
      });
    }

    if (!result.cursor || seenCursors.has(result.cursor) || newOffers === 0) break;
    seenCursors.add(result.cursor);
    cursor = result.cursor;
  }

  return offers;
}

async function discoverAllOffers(reportProgress = false): Promise<CapitalOneDiscovery> {
  if (window.location.hostname === "myaccounts.capitalone.com") {
    const redirectUrl = await getOffersFeedUrl();
    return { cards: [], offersByCard: {}, redirectUrl };
  }

  const cards = window.location.hostname === "capitaloneoffers.com"
    ? await discoverFeedCards()
    : await discoverEligibleCards();
  const offersByCard: Record<string, CapitalOneOffer[]> = {};

  for (const [index, card] of cards.entries()) {
    if (cancelled) break;
    offersByCard[card.id] = window.location.hostname === "capitaloneoffers.com"
      ? await listFeedOffers(card, reportProgress ? { cardIndex: index, cardTotal: cards.length } : undefined)
      : await listOffers(card);
    if (window.location.hostname === "capitaloneoffers.com" && index < cards.length - 1 && !cancelled) {
      await delay(FEED_CARD_DELAY_MS);
    }
  }

  return { cards, offersByCard };
}

async function syncDetected(card: CapitalOneCard, offers: CapitalOneOffer[]) {
  if (offers.length === 0) return;
  await chrome.runtime.sendMessage({
    type: "CAPITALONE_OFFERS_DETECTED",
    accountId: card.id,
    cardName: card.name,
    cardLastDigits: card.lastDigits,
    detectedOffers: offers,
  });
}

let cancelled = false;
let lastDiscovery: CapitalOneDiscovery | null = null;

function sendProgress(data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type: "CAPITALONE_OFFERS_PROGRESS", ...data }).catch(() => {});
}

const capitalOneOffersWindow = window as Window & { [CAPITALONE_OFFERS_BOOTSTRAPPED_KEY]?: boolean };

if (!capitalOneOffersWindow[CAPITALONE_OFFERS_BOOTSTRAPPED_KEY]) {
  capitalOneOffersWindow[CAPITALONE_OFFERS_BOOTSTRAPPED_KEY] = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "CAPITALONE_OFFERS_DISCOVER") {
      (async () => {
        cancelled = false;
        sendProgress({
          phase: "discovering",
          cardIndex: 0,
          cardTotal: 1,
          page: 0,
          offersFound: 0,
          progress: 4,
        });

        const discovery = await discoverAllOffers(true);
        lastDiscovery = discovery.cards.length > 0 ? discovery : null;
        const { cards, offersByCard, redirectUrl } = discovery;
        if (redirectUrl) {
          sendResponse({ type: "CAPITALONE_OFFERS_REDIRECT", redirectUrl });
          return;
        }

        if (cards.length === 0) {
          sendResponse({ type: "CAPITALONE_OFFERS_READY", cards: [], offerCounts: {}, error: "no_cards" });
          return;
        }

        const offerCounts: Record<string, number> = {};
        for (const [index, card] of cards.entries()) {
          const offers = offersByCard[card.id] ?? [];
          offerCounts[card.id] = offers.length;
          sendProgress({
            phase: "discovering",
            statusText: "Saving offers...",
            cardName: card.name,
            cardIndex: index,
            cardTotal: cards.length,
            page: FEED_MAX_PAGES,
            offersFound: offers.length,
            progress: Math.min(98, 95 + Math.round(((index + 1) / cards.length) * 3)),
          });
          try {
            await syncDetected(card, offers);
          } catch (error) {
            console.error("[NextCard Capital One Offers] sync failed:", error);
            sendResponse({ type: "CAPITALONE_OFFERS_READY", cards: [], offerCounts, error: "sync_failed" });
            return;
          }
        }

        sendResponse({
          type: "CAPITALONE_OFFERS_READY",
          cards: cards.map((card) => ({ id: card.id, name: card.name, lastDigits: card.lastDigits })),
          offerCounts,
          error: undefined,
        });
      })();
      return true;
    }

    if (message.type === "CAPITALONE_OFFERS_RUN") {
      (async () => {
        cancelled = false;
        sendProgress({ status: "fetching", synced: 0, total: 0 });

        const discovery = lastDiscovery?.cards.length ? lastDiscovery : await discoverAllOffers();
        lastDiscovery = null;
        const { cards, offersByCard } = discovery;
        const total = Object.values(offersByCard).reduce((sum, offers) => sum + offers.length, 0);
        let synced = 0;

        for (const card of cards) {
          if (cancelled) break;
          const offers = offersByCard[card.id] ?? [];
          syncDetected(card, offers);
          synced += offers.length;
          sendProgress({ synced, total });
        }

        chrome.runtime.sendMessage({
          type: "CAPITALONE_OFFERS_COMPLETE",
          synced,
          total,
        }).catch(() => {});
      })();
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === "CAPITALONE_OFFERS_STOP") {
      cancelled = true;
      sendResponse({ ok: true });
      return true;
    }

    return true;
  });
}
