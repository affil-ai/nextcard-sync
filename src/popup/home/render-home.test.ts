import { describe, expect, it } from "vitest";

import type {
  ExtensionRewardsSummary,
  ProviderId,
  ProviderSyncState,
} from "../../lib/types";
import {
  getConnectedTravelProviderIds,
  hasConnectedRewards,
  syncRewardsProvidersSequentially,
} from "./home-state";

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

describe("getConnectedTravelProviderIds", () => {
  it("returns connected airline and hotel programs in display order", () => {
    const summaries: ExtensionRewardsSummary[] = [
      { ...summary, provider: "hilton", programName: "Hilton Honors" },
      { ...summary, provider: "chase" },
      { ...summary, provider: "aa", programName: "American Airlines AAdvantage" },
      { ...summary, provider: "aa", loyaltyAccountId: "account-2" },
    ];

    expect(getConnectedTravelProviderIds(summaries, [])).toEqual([
      "aa",
      "hilton",
    ]);
  });

  it("excludes travel programs locked by the current plan", () => {
    const summaries: ExtensionRewardsSummary[] = [
      { ...summary, provider: "aa" },
      { ...summary, provider: "hilton" },
    ];

    expect(getConnectedTravelProviderIds(summaries, ["hilton"])).toEqual([
      "aa",
    ]);
  });
});

describe("syncRewardsProvidersSequentially", () => {
  it("waits for each program before starting the next", async () => {
    const events: string[] = [];

    const failedCount = await syncRewardsProvidersSequentially({
      providerIds: ["aa", "marriott"],
      startProvider: async (providerId) => {
        events.push(`start:${providerId}`);
        return true;
      },
      waitForCompletion: async (providerId) => {
        events.push(`finish:${providerId}`);
        return { succeeded: true };
      },
      onProgress: (providerId) => events.push(`progress:${providerId}`),
    });

    expect(events).toEqual([
      "progress:aa",
      "start:aa",
      "finish:aa",
      "progress:marriott",
      "start:marriott",
      "finish:marriott",
    ]);
    expect(failedCount).toBe(0);
  });

  it("continues after a program fails", async () => {
    const started: ProviderId[] = [];

    const failedCount = await syncRewardsProvidersSequentially({
      providerIds: ["aa", "marriott"],
      startProvider: async (providerId) => {
        started.push(providerId);
        return providerId !== "aa";
      },
      waitForCompletion: async () => ({ succeeded: true }),
      onProgress: () => {},
    });

    expect(started).toEqual(["aa", "marriott"]);
    expect(failedCount).toBe(1);
  });
});
