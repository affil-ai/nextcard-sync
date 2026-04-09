import { describe, expect, it } from "vitest";
import {
  isLikelyCapitalOneCardTile,
  normalizeCapitalOneRewardsLabel,
  parseCapitalOneRewardsSummary,
  selectCapitalOneCardName,
} from "./capitalone-parsing";

describe("capitalone parsing helpers", () => {
  it("prefers branded image alt text when selecting a card name", () => {
    const cardName = selectCapitalOneCardName({
      imageAlt: "Savor",
      identityText: "...5835",
      primaryText: "...5835 CURRENT BALANCE Pay bill",
      tileText: "...5835 CURRENT BALANCE Pay bill Get your Virtual Card",
    });

    expect(cardName).toBe("Savor");
  });

  it("filters out non-card tiles that lack card branding and card actions", () => {
    const isCardTile = isLikelyCapitalOneCardTile({
      imageSrc: null,
      backgroundImage: "url(https://ecm.capitalone.com/ProductBranding/bank/1/checking/tile.jpg)",
      cardName: "360 Checking",
      primaryText: "360 Checking Available Balance",
      tileText: "360 Checking View account",
      lastDigits: "1234",
    });

    expect(isCardTile).toBe(false);
  });

  it("parses split cashback balances and normalizes the label", () => {
    const rewards = parseCapitalOneRewardsSummary({
      balanceText: "$ 15 . 50",
      dollarText: "15",
      centText: "50",
      labelText: "Rewards cash",
    });

    expect(rewards.amount).toBe(15.5);
    expect(rewards.rewardsLabel).toBe("Cash Back");
  });

  it("keeps miles balances as whole numbers", () => {
    const rewards = parseCapitalOneRewardsSummary({
      balanceText: "12,500",
      dollarText: "12,500",
      centText: "",
      labelText: "Rewards miles",
    });

    expect(rewards.amount).toBe(12500);
    expect(normalizeCapitalOneRewardsLabel(rewards.rewardsLabel)).toBe("Miles");
  });
});
