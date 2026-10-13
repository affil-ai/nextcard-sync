// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { OfferReview } from "./offer-review";
import { selectEligibleOffers } from "../lib/offer-selection";
import type { OfferOperationCard } from "../lib/offer-operation";

const card: OfferOperationCard = { key: "one", name: "Card", lastDigits: "1234", availableCount: 2,
  countStatus: "complete", offers: [
    { id: "a", name: "Merchant A", value: "10% back", details: "Online purchases", terms: "Up to $20" },
    { id: "b", name: "Merchant B", value: "5% back", details: null, terms: null },
  ] };

describe("offer review and issuer selection", () => {
  it("starts with nothing selected, preserves choices across polling, and activates only chosen IDs", () => {
    const review = new OfferReview(); const host = document.createElement("div"); document.body.append(host);
    review.render(host, "run", card, () => {});
    expect(review.selected("run", card)).toEqual([]);
    const input = host.querySelector("input"); if (!input) throw new Error("Missing checkbox");
    input.click(); review.render(host, "run", card, () => {});
    expect(host.querySelector("input")).toBe(input);
    expect(review.selected("run", card)).toEqual(["a"]);
    expect(selectEligibleOffers([{ offerId: "a" }, { offerId: "b" }], review.selected("run", card))).toEqual([{ offerId: "a" }]);
    expect(review.selected("different-run", card)).toEqual([]);
    expect(() => selectEligibleOffers([{ offerId: "b" }], ["a"])).toThrow("no longer available");
  });
  it("keeps card choices separate and offers optional select all and clear", () => {
    const review = new OfferReview(); const host = document.createElement("div"); document.body.append(host);
    review.render(host, "run", card, () => {}); host.querySelector("button")?.click();
    expect(review.selected("run", card)).toEqual(["a", "b"]);
    const other = { ...card, key: "two" }; review.render(host, "run", other, () => {});
    expect(review.selected("run", other)).toEqual([]);
    review.render(host, "run", card, () => {}); host.querySelector("button")?.click();
    expect(review.selected("run", card)).toEqual([]);
    expect(host.textContent).toContain("Up to $20");
  });
});
