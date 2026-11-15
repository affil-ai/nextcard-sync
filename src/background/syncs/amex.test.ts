import { describe, expect, it } from "vitest";
import { findSelectedAmexCardOption } from "./amex";

const options = [
  { name: "Hilton Honors Aspire Card", lastDigits: "31003", index: 0 },
  { name: "Business Gold Card", lastDigits: "61003", index: 2 },
];

describe("findSelectedAmexCardOption", () => {
  it("skips only the first card when two cards share their last 4", () => {
    expect(findSelectedAmexCardOption(options, { cardName: "Hilton Honors Aspire Card (•31003)", lastFourDigits: "31003" })).toBe(0);
    expect(findSelectedAmexCardOption(options, { cardName: "Business Gold Card (•61003)", lastFourDigits: "61003" })).toBe(2);
  });

  it("matches a 4-digit selected suffix to the one same-name option", () => {
    expect(findSelectedAmexCardOption(options, { cardName: "Business Gold Card (1003)", lastFourDigits: "1003" })).toBe(2);
  });

  it("skips nothing when the selected card can't be told apart", () => {
    const twins = [
      { name: "Gold Card", lastDigits: "31003", index: 0 },
      { name: "Gold Card", lastDigits: "61003", index: 1 },
    ];
    expect(findSelectedAmexCardOption(twins, { cardName: "Gold Card (1003)", lastFourDigits: "1003" })).toBeNull();
    expect(findSelectedAmexCardOption(twins, { cardName: "Gold Card (•61003)", lastFourDigits: "61003" })).toBe(1);
    expect(findSelectedAmexCardOption(options, { cardName: "Platinum Card", lastFourDigits: null })).toBeNull();
  });
});
