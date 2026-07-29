import { describe, expect, it } from "vitest";

import type {
  ExtensionRewardsSummary,
  ProviderSyncState,
} from "../../lib/types";
import { hasConnectedRewards } from "./home-state";

const summary: ExtensionRewardsSummary = {
  provider: "chase",
  loyaltyAccountId: "account-1",
  rewardsProgramId: "program-1",
  programSlug: "chase",
  programName: "Chase Ultimate Rewards",
  iconUrl: null,
  pointsBalance: 100_000,
  statusLevel: null,
  cardCount: 2,
  benefitCount: 1,
  lastSyncedAt: "2026-07-28T12:00:00.000Z",
  dashboardPath: "/dashboard/rewards?program=chase",
};

const syncedState: ProviderSyncState = {
  status: "done",
  data: null,
  error: null,
  lastSyncedAt: "2026-07-28T12:00:00.000Z",
  progressMessage: null,
};

describe("hasConnectedRewards", () => {
  it("keeps the setup intro for a true first-time user", () => {
    expect(hasConnectedRewards({}, [], false)).toBe(false);
  });

  it("recognizes server summaries after an extension reinstall", () => {
    expect(hasConnectedRewards({}, [summary], false)).toBe(true);
  });

  it("recognizes completed local sync state", () => {
    expect(
      hasConnectedRewards({ chase: syncedState }, [], false),
    ).toBe(true);
  });

  it("preserves the completed onboarding state between sessions", () => {
    expect(hasConnectedRewards({}, [], true)).toBe(true);
  });
});
