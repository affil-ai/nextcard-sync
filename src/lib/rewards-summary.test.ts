import { describe, expect, it } from "vitest";
import {
  formatRewardsSummaryBalance,
  getRewardsSummaryMeta,
  normalizeRewardsSummaries,
} from "./rewards-summary";
import type { ExtensionRewardsSummary } from "./types";

const summary: ExtensionRewardsSummary = {
  provider: "chase",
  loyaltyAccountId: "account-1",
  rewardsProgramId: "program-1",
  programSlug: "chase-ultimate-rewards",
  programName: "Chase Ultimate Rewards",
  iconUrl: null,
  pointsBalance: 486640,
  statusLevel: null,
  cardCount: 2,
  benefitCount: 4,
  lastSyncedAt: "2026-07-28T22:00:00.000Z",
  dashboardPath:
    "/dashboard/rewards?program=chase-ultimate-rewards",
};

describe("extension rewards summaries", () => {
  it("accepts the compact backend contract", () => {
    expect(normalizeRewardsSummaries([summary])).toEqual([summary]);
    expect(getRewardsSummaryMeta(summary)).toBe(
      "2 cards · 4 benefits",
    );
    expect(formatRewardsSummaryBalance(summary)).toBe("486,640");
  });

  it("omits vague detail counts for standalone loyalty programs", () => {
    expect(getRewardsSummaryMeta({
      ...summary,
      provider: "atmos",
      cardCount: 0,
      benefitCount: 3,
    })).toBe("");
  });

  it("filters malformed records and creates a safe dashboard fallback", () => {
    expect(normalizeRewardsSummaries([
      { ...summary, dashboardPath: "https://example.com/phishing" },
      { ...summary, loyaltyAccountId: null },
    ])).toEqual([
      {
        ...summary,
        dashboardPath:
          "/dashboard/rewards?program=chase-ultimate-rewards",
      },
    ]);
  });

  it("keeps the newest duplicate account record", () => {
    expect(normalizeRewardsSummaries([
      summary,
      { ...summary, pointsBalance: 500000 },
    ])).toHaveLength(1);
    expect(normalizeRewardsSummaries([
      summary,
      { ...summary, pointsBalance: 500000 },
    ])[0]?.pointsBalance).toBe(500000);
  });
});
