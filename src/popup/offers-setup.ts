import type {
  OfferIssuer,
  OfferOperationSnapshot,
  OfferOperationState,
} from "../lib/offer-operation";
import type { NextCardAuth } from "../lib/types";

export type OffersSetupStage =
  | "choose_issuer"
  | "check_offers"
  | "review_offers"
  | "sync_rewards"
  | "complete";

const OFFERS_SETUP_COMPLETED_KEY_PREFIX = "offersSetupCompleted:";

export function getOffersSetupCompletedStorageKey(
  auth: Pick<NextCardAuth, "email" | "signedInAt"> | null,
) {
  if (!auth) return null;
  const accountIdentity = auth.email?.trim().toLowerCase() || auth.signedInAt;
  return `${OFFERS_SETUP_COMPLETED_KEY_PREFIX}${accountIdentity}`;
}

export function isOffersSetupComplete(stage: OffersSetupStage) {
  return stage === "complete";
}

function getLatestHistoryState(snapshot: OfferOperationSnapshot) {
  return Object.values(snapshot.history)
    .filter((state): state is OfferOperationState => Boolean(state))
    .sort((left, right) => (
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    ))[0] ?? null;
}

export function getOffersSetupState(
  snapshot: OfferOperationSnapshot,
  firstRewardsSyncCompleted: boolean,
  preferredIssuer: OfferIssuer | null = null,
) {
  const operation =
    snapshot.active
    ?? (preferredIssuer ? snapshot.history[preferredIssuer] ?? null : null)
    ?? getLatestHistoryState(snapshot);
  const issuer = operation?.issuer ?? preferredIssuer;

  if (!operation) {
    return {
      stage: issuer ? "check_offers" as const : "choose_issuer" as const,
      issuer,
      operation: null,
      rewardsCompleted: firstRewardsSyncCompleted,
    };
  }

  if (operation.phase === "completed") {
    return {
      stage: firstRewardsSyncCompleted ? "complete" as const : "sync_rewards" as const,
      issuer,
      operation,
      rewardsCompleted: firstRewardsSyncCompleted,
    };
  }

  if (operation.phase === "ready_to_add" || operation.phase === "adding") {
    return {
      stage: "review_offers" as const,
      issuer,
      operation,
      rewardsCompleted: firstRewardsSyncCompleted,
    };
  }

  return {
    stage: "check_offers" as const,
    issuer,
    operation,
    rewardsCompleted: firstRewardsSyncCompleted,
  };
}
