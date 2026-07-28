import { describe, expect, it } from "vitest";
import type {
  OfferIssuer,
  OfferOperationPhase,
  OfferOperationSnapshot,
  OfferOperationState,
} from "../lib/offer-operation";
import {
  getOffersSetupCompletedStorageKey,
  getOffersSetupState,
  isOffersSetupComplete,
} from "./offers-setup";

function operation(
  issuer: OfferIssuer,
  phase: OfferOperationPhase,
  updatedAt = "2026-07-28T12:00:00.000Z",
): OfferOperationState {
  return {
    runId: `${issuer}-run`,
    issuer,
    phase,
    ownedTabId: null,
    startedAt: updatedAt,
    updatedAt,
    checkedAt: phase === "ready_to_add" ? updatedAt : null,
    cards: [],
    selectedCardKeys: [],
    total: null,
    added: 0,
    failed: 0,
    remaining: null,
    cancelled: phase === "cancelled",
    error: null,
    saveStatus: "not_started",
    saveError: null,
  };
}

describe("getOffersSetupState", () => {
  it("starts by asking the user to choose an issuer", () => {
    expect(getOffersSetupState({ active: null, history: {} }, false).stage)
      .toBe("choose_issuer");
  });

  it("moves through checking, reviewing, and the rewards handoff", () => {
    const phases: Array<[OfferOperationPhase, string]> = [
      ["checking", "check_offers"],
      ["ready_to_add", "review_offers"],
      ["adding", "review_offers"],
      ["completed", "sync_rewards"],
    ];

    for (const [phase, expectedStage] of phases) {
      const snapshot: OfferOperationSnapshot = {
        active: operation("amex", phase),
        history: {},
      };
      expect(getOffersSetupState(snapshot, false).stage).toBe(expectedStage);
    }
  });

  it("restores the most recently updated issuer from history", () => {
    const snapshot: OfferOperationSnapshot = {
      active: null,
      history: {
        chase: operation("chase", "failed", "2026-07-28T10:00:00.000Z"),
        citi: operation("citi", "ready_to_add", "2026-07-28T11:00:00.000Z"),
      },
    };

    expect(getOffersSetupState(snapshot, false)).toMatchObject({
      stage: "review_offers",
      issuer: "citi",
    });
  });

  it("still guides Offers when Rewards was synced first", () => {
    expect(getOffersSetupState({ active: null, history: {} }, true)).toMatchObject({
      stage: "choose_issuer",
      rewardsCompleted: true,
    });
  });

  it("finishes after both an offer activation and rewards sync", () => {
    const snapshot: OfferOperationSnapshot = {
      active: null,
      history: {
        amex: operation("amex", "completed"),
      },
    };
    expect(getOffersSetupState(snapshot, true).stage).toBe("complete");
  });
});

describe("offers setup completion", () => {
  it("keeps setup open while rewards are still the active fourth step", () => {
    expect(isOffersSetupComplete("sync_rewards")).toBe(false);
    expect(isOffersSetupComplete("complete")).toBe(true);
  });

  it("scopes completion to a normalized account identity", () => {
    expect(getOffersSetupCompletedStorageKey({
      email: " User@Example.com ",
      signedInAt: "2026-07-28T12:00:00.000Z",
    })).toBe("offersSetupCompleted:user@example.com");
    expect(getOffersSetupCompletedStorageKey({
      email: null,
      signedInAt: "2026-07-28T12:00:00.000Z",
    })).toBe("offersSetupCompleted:2026-07-28T12:00:00.000Z");
    expect(getOffersSetupCompletedStorageKey(null)).toBeNull();
  });
});
