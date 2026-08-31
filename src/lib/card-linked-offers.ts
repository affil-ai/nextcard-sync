import { z } from "zod";

export const CARD_LINKED_OFFERS_STORAGE_KEY = "cardLinkedOffers";

export type MerchantOfferSyncStatus = "enrolled" | "detected";

const cardLinkedOfferSchema = z.object({
  merchantName: z.string().min(1),
  merchantUrl: z.string().nullable(),
  offerValue: z.string().nullable(),
  issuer: z.string().min(1),
  cardName: z.string(),
  cardLastDigits: z.string().nullable(),
  expirationDate: z.string().nullable(),
  rewardType: z.enum(["percentage", "flat_cash", "points"]).nullable(),
  rewardAmount: z.number().nullable(),
  status: z.enum(["enrolled", "detected"]).default("enrolled"),
});

export type CardLinkedOffer = z.infer<typeof cardLinkedOfferSchema>;

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

export function getOfferHostnameCandidates(hostname: string): string[] {
  const labels = hostname.split(".").filter(Boolean);
  const candidates = [hostname];

  while (labels.length > 2) {
    const hasCountryCodeSuffix = labels.length === 3
      && labels.at(-1)?.length === 2
      && (labels.at(-2)?.length ?? 0) <= 3;
    if (hasCountryCodeSuffix) break;
    labels.shift();
    candidates.push(labels.join("."));
  }

  return candidates;
}

export function parseCardLinkedOffers(value: unknown): CardLinkedOffer[] {
  if (!value || typeof value !== "object" || !("offers" in value)) return [];
  const offers = value.offers;
  if (!Array.isArray(offers)) return [];

  return offers.flatMap((offer) => {
    const result = cardLinkedOfferSchema.safeParse(offer);
    return result.success ? [result.data] : [];
  });
}

export function isCurrentCardLinkedOffer(offer: CardLinkedOffer, now = Date.now()): boolean {
  if (!offer.expirationDate) return true;
  const expirationTime = new Date(offer.expirationDate).getTime();
  return Number.isNaN(expirationTime) || expirationTime > now;
}

export function sortCardLinkedOffers(offers: CardLinkedOffer[]): CardLinkedOffer[] {
  return [...offers].sort((left, right) => {
    if (left.status !== right.status) return left.status === "enrolled" ? -1 : 1;

    const rewardDifference = (right.rewardAmount ?? 0) - (left.rewardAmount ?? 0);
    if (rewardDifference !== 0) return rewardDifference;

    const leftExpiration = left.expirationDate
      ? new Date(left.expirationDate).getTime()
      : Number.POSITIVE_INFINITY;
    const rightExpiration = right.expirationDate
      ? new Date(right.expirationDate).getTime()
      : Number.POSITIVE_INFINITY;
    const expirationDifference = leftExpiration - rightExpiration;
    if (!Number.isNaN(expirationDifference) && expirationDifference !== 0) {
      return expirationDifference;
    }

    return left.merchantName.localeCompare(right.merchantName);
  });
}

export function buildOfferUrlCaches(offers: CardLinkedOffer[]): {
  enrolled: OfferUrlCache;
  detected: OfferUrlCache;
} {
  const enrolled: OfferUrlCache = {};
  const detected: OfferUrlCache = {};

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
    const target = offer.status === "detected" ? detected : enrolled;
    target[host] = [...(target[host] ?? []), entry];
  }

  return { enrolled, detected };
}

export function getOfferValueLabel(offer: CardLinkedOffer): string {
  if (offer.offerValue?.trim()) return offer.offerValue.trim();
  if (offer.rewardAmount == null) return "Card-linked offer";
  if (offer.rewardType === "percentage") return `${offer.rewardAmount}% back`;
  if (offer.rewardType === "flat_cash") return `$${offer.rewardAmount} back`;
  if (offer.rewardType === "points") return `${offer.rewardAmount.toLocaleString()} points`;
  return "Card-linked offer";
}
