import type {
  ExtensionRewardsSummary,
  ProviderId,
  ProviderSyncState,
} from "../../lib/types";
import { orderedProviderIds } from "../../providers/provider-groups";

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
