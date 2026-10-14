import { describe, expect, it } from "vitest";
import {
  collectBofaOfferIds,
  getBofaOfferAction,
  normalizeBofaOffer,
  type BofaOffer,
} from "./bofa-offers";

function offer(change: Partial<BofaOffer> = {}): BofaOffer {
  return {
    offer_id: "12345",
    merchant_name: "Fixture merchant",
    headline: "Fixture offer",
    type: "CARD_LINKED",
    activation_required: false,
    activation_type: null,
    activation_triggers: null,
    is_activated: false,
    activation_expires_at: null,
    expiration_date: "2027-01-01",
    description: "Details",
    terms_and_conditions: "Use an eligible card.",
    reward_type: "PERCENTAGE",
    reward_rate: 5,
    reward_value: 0,
    display_currency: "CASH",
    reward_tiers: [],
    offer_mode: "ONLINE",
    ...change,
  };
}
describe("BofA redemption and discovery", () => {
  it("keeps automatically available, affiliate, link-activated, and merchant discounts out of click activation", () => {
    expect(getBofaOfferAction(offer())).toBe("ready");
    expect(getBofaOfferAction(offer({ type: "AFFILIATE" }))).toBe(
      "shop_through_issuer",
    );
    expect(
      getBofaOfferAction(
        offer({
          activation_required: true,
          activation_type: "LINK",
          activation_triggers: ["OUTBOUND_LINK_CLICK"],
        }),
      ),
    ).toBe("shop_through_issuer");
    const discount = normalizeBofaOffer(
      offer({
        type: "MERCHANT_FULFILLED",
        headline: "Save 5%-50%",
        reward_rate: 0,
      }),
    );
    expect(discount).toMatchObject({
      action: "merchant_deal",
      offerValue: "Save 5%-50%",
      rewardAmount: null,
      rewardType: null,
    });
  });
  it("uses the issuer's activation expiry and refuses unknown activation rules", () => {
    const click = offer({
      activation_required: true,
      activation_type: "CLICK",
      activation_triggers: ["OFFER_DETAILS_CLICK"],
      is_activated: true,
      activation_expires_at: "2026-10-17T06:59:59+00:00",
    });
    expect(getBofaOfferAction(click, Date.parse("2026-10-16T12:00:00Z"))).toBe(
      "activated",
    );
    expect(getBofaOfferAction(click, Date.parse("2026-10-18T12:00:00Z"))).toBe(
      "activate",
    );
    expect(() =>
      getBofaOfferAction(
        offer({ activation_required: true, activation_type: null }),
      ),
    ).toThrow("unsupported");
  });
  it("loads all 1408 offers through the last partial page", async () => {
    const offsets: number[] = [];
    const ids = await collectBofaOfferIds(async (offset) => {
      offsets.push(offset);
      return {
        total: 1408,
        offers: Array.from({ length: Math.min(24, 1408 - offset) }, (_, i) => ({
          offer_id: String(offset + i + 1),
        })),
      };
    });
    expect(ids).toHaveLength(1408);
    expect(offsets).toHaveLength(59);
    expect(ids.at(-1)).toBe("1408");
  });
  it("does not call a repeated or interrupted inventory complete", async () => {
    await expect(
      collectBofaOfferIds(async (offset) => ({
        total: 48,
        offers: Array.from({ length: 24 }, (_, i) => ({
          offer_id: String(i + 1),
        })),
      })),
    ).rejects.toThrow("repeated");
    await expect(
      collectBofaOfferIds(async (offset) => ({
        total: 48,
        offers: offset
          ? []
          : Array.from({ length: 24 }, (_, i) => ({ offer_id: String(i + 1) })),
      })),
    ).rejects.toThrow("incomplete");
  });
});
