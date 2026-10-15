import { z } from "zod";

const nullableNumber = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .transform(Number),
  ])
  .nullish();
export const bofaOfferSchema = z.object({
  offer_id: z.string().regex(/^\d+$/),
  merchant_name: z.string().min(1),
  headline: z.string(),
  type: z.enum(["CARD_LINKED", "AFFILIATE", "MERCHANT_FULFILLED"]),
  activation_required: z.boolean(),
  activation_type: z.enum(["CLICK", "LINK"]).nullish(),
  activation_triggers: z.array(z.string()).nullish(),
  is_activated: z.boolean(),
  activation_expires_at: z.string().datetime({ offset: true }).nullish(),
  expiration_date: z.string().nullish(),
  category: z.string().nullish(),
  description: z.string().max(95000),
  terms_and_conditions: z.string().max(100000),
  reward_type: z.enum(["PERCENTAGE", "FIXED"]),
  reward_rate: nullableNumber,
  reward_value: nullableNumber,
  reward_tiers: z.array(z.unknown()).default([]),
  display_currency: z.string(),
  minimum_spend: nullableNumber,
  maximum_reward_per_transaction: nullableNumber,
  merchant_website: z.string().nullish(),
  merchant_logo_url: z.string().nullish(),
  offer_mode: z.enum(["ONLINE", "IN_PERSON", "IN_PERSON_AND_ONLINE"]),
  redemption_coupon_code: z.string().nullish(),
});

export const portalActionSchema = z.enum([
  "ready",
  "activate",
  "activated",
  "shop_through_issuer",
  "merchant_deal",
]);
export type BofaOffer = z.infer<typeof bofaOfferSchema>;
export const portalOfferSchema = z.object({
  offerType: z.enum(["CARD_LINKED", "AFFILIATE", "MERCHANT_FULFILLED"]).optional(),
  issuerOfferId: z.string(),
  merchantName: z.string(),
  offerValue: z.string().nullable(),
  detailsText: z.string(),
  termsText: z.string(),
  category: z.string().nullable(),
  expirationDate: z.string().nullable(),
  rewardType: z.enum(["percentage", "flat_cash"]).nullable(),
  rewardAmount: z.number().nullable(),
  rewardCurrency: z.string().nullable(),
  maxReward: z.number().nullable(),
  minSpend: z.number().nullable(),
  merchantUrl: z.string().nullable(),
  merchantLogoUrl: z.string().nullable(),
  redemptionChannel: z.enum(["online", "in_store", "both"]).nullable(),
  action: portalActionSchema,
  activationExpiresAt: z.string().nullable(),
});
export type PortalOffer = z.infer<typeof portalOfferSchema>;

export function getBofaOfferAction(
  offer: BofaOffer,
  now = Date.now(),
): PortalOffer["action"] {
  if (offer.type === "AFFILIATE") return "shop_through_issuer";
  if (offer.type === "MERCHANT_FULFILLED") return "merchant_deal";
  if (!offer.activation_required) return "ready";
  if (
    offer.activation_type === "LINK" &&
    offer.activation_triggers?.includes("OUTBOUND_LINK_CLICK")
  )
    return "shop_through_issuer";
  if (
    offer.activation_type !== "CLICK" ||
    !offer.activation_triggers?.includes("OFFER_DETAILS_CLICK")
  ) {
    throw new Error("BofA returned an unsupported activation rule.");
  }
  return offer.is_activated &&
    (!offer.activation_expires_at ||
      Date.parse(offer.activation_expires_at) > now)
    ? "activated"
    : "activate";
}

export function normalizeBofaOffer(offer: BofaOffer): PortalOffer {
  const supportsNumericReward =
    offer.type !== "MERCHANT_FULFILLED" &&
    !offer.reward_tiers.length &&
    offer.display_currency === "CASH";
  const amount = supportsNumericReward
    ? ((offer.reward_type === "PERCENTAGE"
        ? offer.reward_rate
        : offer.reward_value) ?? null)
    : null;
  const categoryMap: Record<string, string> = {
    AUTOMOTIVE: "transportation",
    HEALTH_AND_BEAUTY: "health",
    FOOD: "food",
    HOME: "home",
    TRAVEL: "travel",
    ENTERTAINMENT: "entertainment",
  };
  const action = getBofaOfferAction(offer);
  const value =
    amount !== null && amount > 0
      ? `${offer.reward_type === "PERCENTAGE" ? `${amount}%` : `$${amount}`} cash back`
      : offer.headline;
  return {
    offerType: offer.type,
    issuerOfferId: offer.offer_id,
    merchantName: offer.merchant_name,
    offerValue: value,
    detailsText: [
      offer.headline,
      offer.description,
      offer.redemption_coupon_code
        ? `Coupon code: ${offer.redemption_coupon_code}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    termsText: offer.terms_and_conditions,
    category: offer.category
      ? (categoryMap[offer.category] ?? "general")
      : null,
    expirationDate: offer.expiration_date ?? null,
    rewardType:
      amount !== null && amount > 0
        ? offer.reward_type === "PERCENTAGE"
          ? "percentage"
          : "flat_cash"
        : null,
    rewardAmount: amount !== null && amount > 0 ? amount : null,
    rewardCurrency: supportsNumericReward ? "cash" : null,
    maxReward: offer.maximum_reward_per_transaction ?? null,
    minSpend: offer.minimum_spend ?? null,
    merchantUrl: offer.merchant_website ?? null,
    merchantLogoUrl: offer.merchant_logo_url ?? null,
    redemptionChannel:
      offer.offer_mode === "ONLINE"
        ? "online"
        : offer.offer_mode === "IN_PERSON"
          ? "in_store"
          : "both",
    action,
    activationExpiresAt: offer.activation_expires_at ?? null,
  };
}

export async function collectBofaOfferIds(
  fetchPage: (offset: number) => Promise<unknown>,
  onPage?: (discovered: number, total: number) => Promise<void>,
) {
  const schema = z.object({
    offers: z.array(z.object({ offer_id: z.string().regex(/^\d+$/) })),
    total: z.number().int().nonnegative(),
  });
  const ids = new Set<string>();
  let total: number | undefined;
  let inventoryChanged = false;
  for (let offset = 0; offset < 10000; offset += 24) {
    const page = schema.parse(await fetchPage(offset));
    if (total !== undefined && total !== page.total) inventoryChanged = true;
    total = page.total;
    if (page.offers.length > 24 || (!page.offers.length && offset < total))
      throw new Error("BofA returned an incomplete offer page.");
    const before = ids.size;
    page.offers.forEach((o) => ids.add(o.offer_id));
    if (offset > 0 && page.offers.length && ids.size === before)
      throw new Error("BofA repeated offers between pages. Check again.");
    await onPage?.(ids.size, total);
    if (offset + page.offers.length >= total) {
      if (!inventoryChanged && ids.size !== total)
        throw new Error("BofA repeated offers between pages. Check again.");
      return [...ids];
    }
    if (ids.size === before || page.offers.length !== 24)
      throw new Error("BofA returned an incomplete offer page.");
  }
  throw new Error("BofA's offer inventory exceeded the supported scan size.");
}

export const bofaPortalStateSchema = z.object({
  runId: z.string(),
  reviewFinished: z.boolean().optional(),
  phase: z.enum([
    "checking",
    "ready",
    "activating",
    "completed",
    "cancelled",
    "failed",
  ]),
  total: z.number(),
  checked: z.number(),
  discovered: z.number(),
  added: z.number(),
  failed: z.number(),
  offers: z.array(portalOfferSchema),
  error: z.string().nullable(),
  saveStatus: z.enum(["saving", "saved", "queued_for_retry", "failed"]),
});
export type BofaPortalState = z.infer<typeof bofaPortalStateSchema>;
export const bofaPortalBatchSchema = z.object({
  issuerPortalId: z.string().regex(/^v1:[a-f0-9]{64}$/),
  capturedAt: z.string(),
  offers: z.array(portalOfferSchema),
});
export type BofaPortalBatch = z.infer<typeof bofaPortalBatchSchema>;
