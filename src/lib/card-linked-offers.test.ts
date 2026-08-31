import { describe, expect, it } from "vitest";
import {
  buildOfferUrlCaches,
  getOfferHostnameCandidates,
  getOfferValueLabel,
  isCurrentCardLinkedOffer,
  parseCardLinkedOffers,
  sortCardLinkedOffers,
  type CardLinkedOffer,
} from "./card-linked-offers";

const enrolledOffer: CardLinkedOffer = {
  merchantName: "Acme",
  merchantUrl: "https://www.acme.example/deals",
  offerValue: "$20 back",
  issuer: "chase",
  cardName: "Sapphire Preferred",
  cardLastDigits: "1234",
  expirationDate: "2026-12-31T23:59:59.000Z",
  rewardType: "flat_cash",
  rewardAmount: 20,
  status: "enrolled",
};

describe("parseCardLinkedOffers", () => {
  it("keeps valid offers, defaults legacy status, and drops malformed entries", () => {
    const { status: _status, ...legacyOffer } = enrolledOffer;
    expect(parseCardLinkedOffers({
      offers: [legacyOffer, { merchantName: "Incomplete" }],
    })).toEqual([enrolledOffer]);
  });
});

describe("buildOfferUrlCaches", () => {
  it("keeps enrolled and detected offers in separate hostname caches", () => {
    const detectedOffer: CardLinkedOffer = {
      ...enrolledOffer,
      merchantName: "Beta",
      merchantUrl: "https://beta.example",
      status: "detected",
    };

    expect(buildOfferUrlCaches([enrolledOffer, detectedOffer])).toEqual({
      enrolled: {
        "acme.example": [expect.objectContaining({ merchantName: "Acme", status: "enrolled" })],
      },
      detected: {
        "beta.example": [expect.objectContaining({ merchantName: "Beta", status: "detected" })],
      },
    });
  });
});

describe("getOfferHostnameCandidates", () => {
  it("matches an offer saved for a parent merchant domain on a shopping subdomain", () => {
    expect(getOfferHostnameCandidates("checkout.shop.acme.com")).toEqual([
      "checkout.shop.acme.com",
      "shop.acme.com",
      "acme.com",
    ]);
    expect(getOfferHostnameCandidates("shop.acme.co.uk")).toEqual([
      "shop.acme.co.uk",
      "acme.co.uk",
    ]);
  });
});

describe("offer display helpers", () => {
  it("puts added offers before available offers and higher values first", () => {
    const offers = [
      { ...enrolledOffer, merchantName: "Available", rewardAmount: 50, status: "detected" as const },
      { ...enrolledOffer, merchantName: "Smaller", rewardAmount: 5 },
      { ...enrolledOffer, merchantName: "Larger", rewardAmount: 25 },
    ];
    expect(sortCardLinkedOffers(offers).map((offer) => offer.merchantName)).toEqual([
      "Larger",
      "Smaller",
      "Available",
    ]);
  });

  it("does not show an expired offer", () => {
    expect(isCurrentCardLinkedOffer(enrolledOffer, Date.parse("2026-12-01"))).toBe(true);
    expect(isCurrentCardLinkedOffer(enrolledOffer, Date.parse("2027-01-01"))).toBe(false);
  });

  it("formats a structured reward when the backend has no offer label", () => {
    expect(getOfferValueLabel({
      ...enrolledOffer,
      offerValue: null,
      rewardType: "percentage",
      rewardAmount: 10,
    })).toBe("10% back");
  });
});
