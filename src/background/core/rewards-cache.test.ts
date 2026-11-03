import { describe, expect, it } from "vitest";
import { createRewardsSummaryCache } from "./rewards-cache";
import { REWARDS_SUMMARIES_STORAGE_KEY as globalKey } from "../../lib/rewards-summary";
import { getHouseholdRewardsSummariesStorageKey } from "../../lib/household-context";
import type { ExtensionRewardsSummary } from "../../lib/types";

const source = {
  accountScopeId: "owner",
  memberId: "primary",
  memberLifecycleVersion: 0,
};
const target = { ...source, memberId: "spouse" };
const sourceKey = getHouseholdRewardsSummariesStorageKey(
  source.accountScopeId,
  source.memberId,
  0,
);
const targetKey = getHouseholdRewardsSummariesStorageKey(
  target.accountScopeId,
  target.memberId,
  0,
);
const row = (id: string): ExtensionRewardsSummary => ({
  provider: "delta",
  loyaltyAccountId: id,
  rewardsProgramId: "program",
  programSlug: "delta-skymiles",
  programName: "Sample program",
  iconUrl: null,
  pointsBalance: 42,
  statusLevel: null,
  cardCount: 0,
  benefitCount: 0,
  lastSyncedAt: "2026-10-01",
  dashboardPath: "/dashboard/rewards",
});
function fixture() {
  const stored: Record<string, unknown> = {
    [globalKey]: [row("a"), row("b")],
    [sourceKey]: [row("a"), row("b")],
  };
  let generation = 0;
  const cache = createRewardsSummaryCache({
    getAuthGeneration: () => generation,
    storage: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, stored[key]]));
      },
      async set(updates) {
        Object.assign(stored, updates);
      },
    },
  });
  return {
    cache,
    stored,
    changeAccount: () => {
      generation += 1;
    },
  };
}

describe("profile-scoped rewards list", () => {
  it("persists removal for reopening the popup and refuses an older server response", async () => {
    const { cache, stored } = fixture();
    const oldPull = cache.capture();
    await cache.remove(cache.capture(), "a", source);
    expect(stored[globalKey]).toEqual([row("b")]);
    expect(stored[sourceKey]).toEqual([row("b")]);
    expect(await cache.publish(oldPull, [row("a"), row("b")], source)).toBe(
      false,
    );
    expect(stored[globalKey]).toEqual([row("b")]);
  });
  it("discards a late old-profile pull after the new profile's list loads", async () => {
    const { cache, stored } = fixture();
    const oldPull = cache.capture();
    await cache.invalidateProfile();
    await cache.publish(cache.capture(), [row("spouse")], target);
    expect(await cache.publish(oldPull, [row("a")], source)).toBe(false);
    expect(stored[globalKey]).toEqual([row("spouse")]);
    expect(stored[targetKey]).toEqual([row("spouse")]);
  });
  it("finishes a confirmed removal in its source cache after the user switches profiles", async () => {
    const { cache, stored } = fixture();
    const operation = cache.capture();
    await cache.invalidateProfile();
    await cache.publish(cache.capture(), [row("spouse")], target);
    await cache.remove(operation, "a", source);
    expect(stored[globalKey]).toEqual([row("spouse")]);
    expect(stored[sourceKey]).toEqual([row("b")]);
    expect(stored[targetKey]).toEqual([row("spouse")]);
  });
  it("never recreates previous-account data after sign-out or account change", async () => {
    const { cache, stored, changeAccount } = fixture();
    const oldRead = cache.capture();
    changeAccount();
    await cache.invalidateProfile();
    delete stored[sourceKey];
    stored[globalKey] = [row("other-account")];
    await cache.remove(oldRead, "a", source);
    expect(await cache.publish(oldRead, [row("a")], source)).toBe(false);
    expect(stored[sourceKey]).toBeUndefined();
    expect(stored[globalKey]).toEqual([row("other-account")]);
  });
  it("preserves simultaneous removals instead of restoring the other removed row", async () => {
    const { cache, stored } = fixture();
    const first = cache.capture();
    const second = cache.capture();
    await Promise.all([
      cache.remove(first, "a", source),
      cache.remove(second, "b", source),
    ]);
    expect(stored[globalKey]).toEqual([]);
    expect(stored[sourceKey]).toEqual([]);
  });
});
