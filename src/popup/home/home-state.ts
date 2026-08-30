import type {
  ExtensionRewardsSummary,
  ProviderId,
  ProviderSyncState,
} from "../../lib/types";
import { orderedProviderIds } from "../../providers/provider-groups";
import { providerRegistry } from "../../providers/provider-registry";

export interface RewardsSyncAllState {
  status: "idle" | "running" | "complete";
  providerIds: ProviderId[];
  currentProviderId: ProviderId | null;
  processedCount: number;
  failedCount: number;
}

interface RewardsSyncQueueOptions {
  providerIds: ProviderId[];
  startProvider: (providerId: ProviderId) => Promise<boolean>;
  waitForCompletion: (
    providerId: ProviderId,
  ) => Promise<{ succeeded: boolean }>;
  onProgress: (
    providerId: ProviderId,
    processedCount: number,
    failedCount: number,
  ) => void;
}

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

export async function syncRewardsProvidersSequentially(
  options: RewardsSyncQueueOptions,
) {
  let failedCount = 0;

  for (const [index, providerId] of options.providerIds.entries()) {
    options.onProgress(providerId, index, failedCount);

    try {
      const started = await options.startProvider(providerId);
      if (!started) {
        failedCount += 1;
        continue;
      }

      const completion = await options.waitForCompletion(providerId);
      if (!completion.succeeded) {
        failedCount += 1;
      }
    } catch {
      failedCount += 1;
    }
  }

  return failedCount;
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
