import type {
  ExtensionRewardsSummary,
  ProviderId,
  ProviderSyncState,
  TravelSyncState,
} from "../../lib/types";
import { orderedProviderIds } from "../../providers/provider-groups";
import { providerRegistry } from "../../providers/provider-registry";

export type RewardsSyncAllState = TravelSyncState;

export function getConnectedTravelProviderIds(
  rewardsSummaries: ExtensionRewardsSummary[],
  lockedProviders: ProviderId[],
) {
  const summarizedProviders = new Set(
    rewardsSummaries.map((summary) => summary.provider),
  );
  const locked = new Set(lockedProviders);

  return orderedProviderIds.filter((providerId) => (
    summarizedProviders.has(providerId)
    && providerRegistry[providerId].group !== "Banks"
    && !locked.has(providerId)
  ));
}

export function hasConnectedRewards(
  allStates: Partial<Record<ProviderId, ProviderSyncState>>,
  rewardsSummaries: ExtensionRewardsSummary[],
  firstSyncCompleted: boolean,
) {
  return (
    firstSyncCompleted
    || rewardsSummaries.length > 0
    || orderedProviderIds.some((providerId) => {
      const state = allStates[providerId];
      return state?.status === "done" || Boolean(state?.lastSyncedAt);
    })
  );
}
