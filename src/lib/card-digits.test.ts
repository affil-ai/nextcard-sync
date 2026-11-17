import { describe, expect, it } from "vitest";
import { extractCardSuffixDigits, sameCardSuffix } from "./card-digits";

describe("Amex card suffixes", () => {
  it("keeps the five digits Amex shows, and four for other issuers", () => {
    expect(extractCardSuffixDigits("•31003")).toBe("31003");
    expect(extractCardSuffixDigits("Hilton Honors Aspire Card (•31003)")).toBe("31003");
    expect(extractCardSuffixDigits("...1234")).toBe("1234");
    expect(extractCardSuffixDigits("Delta 2025 Card ending 1003")).toBe("1003");
    expect(extractCardSuffixDigits("•12")).toBeNull();
  });

  it("tells apart two cards sharing their last 4 but accepts a 4-digit copy", () => {
    expect(sameCardSuffix("31003", "61003")).toBe(false);
    expect(sameCardSuffix("31003", "1003")).toBe(true);
    expect(sameCardSuffix("31003", "31003")).toBe(true);
  });
});
