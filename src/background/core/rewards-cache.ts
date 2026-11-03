import {
  normalizeRewardsSummaries,
  REWARDS_SUMMARIES_STORAGE_KEY,
} from "../../lib/rewards-summary";
import {
  getHouseholdRewardsSummariesStorageKey,
  type HouseholdOperationScope,
} from "../../lib/household-context";
import type { ExtensionRewardsSummary } from "../../lib/types";

type SummaryScope = Pick<
  HouseholdOperationScope,
  "accountScopeId" | "memberId" | "memberLifecycleVersion"
>;
type Storage = {
  get: (keys: string[]) => Promise<Record<string, unknown>>;
  set: (updates: Record<string, ExtensionRewardsSummary[]>) => Promise<void>;
};

// One publication boundary for asynchronous pulls and confirmed removals.
// Profile changes invalidate old reads before they can replace the visible list.
export function createRewardsSummaryCache(options: {
  storage: Storage;
  getAuthGeneration: () => number;
}) {
  let profileRevision = 0;
  let dataRevision = 0;
  let pending: Promise<void> = Promise.resolve();
  const capture = () => ({
    authGeneration: options.getAuthGeneration(),
    profileRevision,
    dataRevision,
  });
  type Read = ReturnType<typeof capture>;
  const sameProfile = (read: Read) =>
    read.authGeneration === options.getAuthGeneration() &&
    read.profileRevision === profileRevision;
  const isCurrent = (read: Read) =>
    sameProfile(read) && read.dataRevision === dataRevision;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = pending.then(operation);
    pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  function scopedKey(scope: SummaryScope) {
    return getHouseholdRewardsSummariesStorageKey(
      scope.accountScopeId,
      scope.memberId,
      scope.memberLifecycleVersion,
    );
  }
  return {
    capture,
    isCurrent,
    invalidateProfile() {
      profileRevision += 1;
      dataRevision += 1;
      return pending;
    },
    publish(
      read: Read,
      summaries: ExtensionRewardsSummary[],
      scope: SummaryScope | null,
    ) {
      return serial(async () => {
        if (!isCurrent(read)) return false;
        await options.storage.set({
          [REWARDS_SUMMARIES_STORAGE_KEY]: summaries,
          ...(scope ? { [scopedKey(scope)]: summaries } : {}),
        });
        return isCurrent(read);
      });
    },
    remove(read: Read, accountId: string, scope: SummaryScope | null) {
      // Cancel any pull begun before the server confirmed this removal.
      if (sameProfile(read)) dataRevision += 1;
      return serial(async () => {
        if (read.authGeneration !== options.getAuthGeneration()) return;
        const key = scope ? scopedKey(scope) : null;
        const stored = await options.storage.get(
          key
            ? [REWARDS_SUMMARIES_STORAGE_KEY, key]
            : [REWARDS_SUMMARIES_STORAGE_KEY],
        );
        if (read.authGeneration !== options.getAuthGeneration()) return;
        const updates: Record<string, ExtensionRewardsSummary[]> = {};
        const withoutRemoved = (value: unknown) =>
          normalizeRewardsSummaries(value).filter(
            (summary) => summary.loyaltyAccountId !== accountId,
          );
        if (key) updates[key] = withoutRemoved(stored[key]);
        if (sameProfile(read))
          updates[REWARDS_SUMMARIES_STORAGE_KEY] = withoutRemoved(
            stored[REWARDS_SUMMARIES_STORAGE_KEY],
          );
        if (Object.keys(updates).length) await options.storage.set(updates);
      });
    },
  };
}
