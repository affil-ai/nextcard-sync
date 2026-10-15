import { getOfferOperationStatusText, isOfferIssuer } from "../lib/offer-operation";
import type { BofaPortalState } from "../providers/bofa-offers";
import type {
  OfferIssuer,
  OfferOperationSnapshot,
  OfferOperationState,
} from "../lib/offer-operation";
import type { NextCardAuth } from "../lib/types";

export type OffersSetupIssuer = OfferIssuer | "bofa";
export interface BofaOffersSetupState { state: BofaPortalState | null; pending: boolean; error: string | null; }
export function isOffersSetupIssuer(value: unknown): value is OffersSetupIssuer { return value === "bofa" || isOfferIssuer(value); }

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
  preferredIssuer: OffersSetupIssuer | null = null,
  bofa: BofaOffersSetupState = { state: null, pending: false, error: null },
) {
  const sharedOperation = snapshot.active
    ?? (preferredIssuer && preferredIssuer !== "bofa" ? snapshot.history[preferredIssuer] ?? null : null)
    ?? (preferredIssuer === "bofa" ? null : getLatestHistoryState(snapshot));
  const bofaSelected = preferredIssuer === "bofa" && (!snapshot.active || snapshot.active.phase === "ready_to_add");
  const bofaPhase = bofa.error ? "failed"
    : bofa.pending && bofa.state?.phase !== "checking" && bofa.state?.phase !== "activating" ? "opening"
    : bofa.state?.phase === "checking" ? "checking"
    : bofa.state?.phase === "activating" ? "adding"
    : bofa.state?.reviewFinished || bofa.state?.phase === "completed" ? "completed"
    : bofa.state?.phase === "ready" ? "ready_to_add"
    : bofa.state?.phase;
  const operation = bofaSelected && bofaPhase
    ? { issuer: "bofa", phase: bofaPhase, statusText: bofaPhase === "adding" ? "Activating Bank of America offers…" : "Checking Bank of America offers…" }
    : sharedOperation ? { ...sharedOperation, statusText: getOfferOperationStatusText(sharedOperation) } : null;
  const issuer: OffersSetupIssuer | null = bofaSelected ? "bofa" : sharedOperation?.issuer ?? preferredIssuer;

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
