import { describe, expect, it } from "vitest";
import {
  buildSharedOfferGroups,
  type SharedOfferSnapshot,
} from "./amex-offer-groups";

const cards = [
  { id: "card-1", name: "Gold", lastDigits: "1001" },
  { id: "card-2", name: "Platinum", lastDigits: "2002" },
];

describe("optional Amex cross-card enrollment", () => {
  it("returns matching eligible targets only when the offer exists on multiple cards", () => {
    const snapshots = new Map<string, SharedOfferSnapshot>([
      ["card-1", { complete: true, offers: [{ offerId: "offer-1", status: "ELIGIBLE" }] }],
      ["card-2", { complete: true, offers: [{ offerId: "offer-1", status: "NOT_ENROLLED" }] }],
    ]);

    const groups = buildSharedOfferGroups("card-1", cards, snapshots);

    expect(groups).toHaveLength(1);
    expect(groups[0].targets.map((target) => target.card.id)).toEqual([
      "card-1",
      "card-2",
    ]);
  });

  it("does not broaden a selected-card-only offer into a cross-card run", () => {
    const snapshots = new Map<string, SharedOfferSnapshot>([
      ["card-1", { complete: true, offers: [{ offerId: "offer-1", status: "ELIGIBLE" }] }],
      ["card-2", { complete: true, offers: [{ offerId: "offer-2", status: "ELIGIBLE" }] }],
    ]);

    expect(buildSharedOfferGroups("card-1", cards, snapshots)).toEqual([]);
  });
});
