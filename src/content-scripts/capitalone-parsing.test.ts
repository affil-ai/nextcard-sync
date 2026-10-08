import { describe, expect, it } from "vitest";
import {
  parseCapitalOneRewardsSummary,
  parseCapitalOneRewardsTileText,
  resolveCapitalOneRewardsSummary,
} from "./capitalone-parsing";

describe("Capital One rewards tile fallback", () => {
  it.each([
    "Explore rewards and benefits\n169,476\nMILES\n&\n$10\n83\nREWARDS CASH\nView rewards",
    "Explore rewards and benefits\n169,476 & $10.83\nMILES\nREWARDS CASH\nView rewards",
    "Explore rewards and benefits\n169,476 & $10\n83\nMILES\nREWARDS CASH\nView rewards",
    "$10.83 REWARDS CASH & 169,476 MILES",
  ])("keeps miles separate from cash: %s", (text) => {
    expect(resolveCapitalOneRewardsSummary({ amount: null, rewardsLabel: null }, text))
      .toEqual({ amount: 169476, rewardsLabel: "Miles" });
  });

  it("rejects the old parser's mixed miles and cash result", () => {
    const primary = parseCapitalOneRewardsSummary({
      balanceText: "169,476", dollarText: "$10", centText: "83", labelText: "MILES",
    });
    expect(primary.amount).toBe(10.83);
    expect(resolveCapitalOneRewardsSummary(primary, "169,476 MILES & $10.83 REWARDS CASH"))
      .toEqual({ amount: 169476, rewardsLabel: "Miles" });
  });

  it.each([
    ["$10.83 REWARDS CASH", 10.83],
    ["$10\n83\nREWARDS CASH", 10.83],
    ["$0.00 CASH BACK", 0],
  ])("reads labeled cashback without losing cents: %s", (text, amount) => {
    expect(parseCapitalOneRewardsTileText(text as string)).toEqual({ amount, rewardsLabel: "Cash Back" });
  });

  it.each([
    "Current balance $169,476 View account",
    "Current balance $20 169,476 MILES",
    "Credit limit $5,000 169,476 MILES",
    "Earn 5 miles per dollar. View rewards",
    "169,476 MILES 200 MILES",
    "Unavailable MILES & $10.83 REWARDS CASH",
    "$10.83 MILES",
    "169,476.83 MILES",
    "Loading rewards...",
  ])("does not guess a balance from unsafe or ambiguous text: %s", (text) => {
    // Marketing copy has no explicitly identified rewards balance. The DOM
    // fallback is limited to View rewards containers; guard this here too.
    expect(parseCapitalOneRewardsTileText(text).amount).toBeNull();
  });

  it.each([
    { balanceText: "169,476", labelText: "MILES" },
    { balanceText: "$10.83", dollarText: "$10", centText: "83", labelText: "Cash Back" },
    { balanceText: "0", labelText: "MILES" },
  ])("preserves valid normal extraction, including zero: %j", (input) => {
    const primary = parseCapitalOneRewardsSummary(input);
    expect(resolveCapitalOneRewardsSummary(primary, "999 MILES")).toEqual(primary);
  });
});
