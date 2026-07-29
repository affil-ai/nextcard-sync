import { describe, expect, it } from "vitest";
import {
  OFFER_RESULT_FRESHNESS_MS,
  OFFER_SAVE_FAILURE_GRACE_MS,
  applyOfferOperationPatch,
  canTransitionOfferOperation,
  createOfferOperation,
  getOfferOperationStatusText,
  getOfferSaveStatusText,
  isOfferCompletionContinuing,
  isOfferResultFresh,
  normalizeOfferOperationSnapshot,
} from "./offer-operation";

describe("offer operation state", () => {
  it("creates a truthful unknown opening state", () => {
    const state = createOfferOperation("chase", "run-1", "2026-07-27T12:00:00.000Z");
    expect(state.phase).toBe("opening");
    expect(state.cards).toEqual([]);
    expect(state.total).toBeNull();
    expect(state.added).toBe(0);
  });

  it("allows the normal check and enrollment path", () => {
    expect(canTransitionOfferOperation("opening", "waiting_for_login")).toBe(true);
    expect(canTransitionOfferOperation("waiting_for_login", "checking")).toBe(true);
    expect(canTransitionOfferOperation("checking", "ready_to_add")).toBe(true);
    expect(canTransitionOfferOperation("ready_to_add", "adding")).toBe(true);
    expect(canTransitionOfferOperation("adding", "completed")).toBe(true);
  });

  it("rejects late or invalid terminal transitions", () => {
    const completed = {
      ...createOfferOperation("amex", "run-2"),
      phase: "completed" as const,
    };
    expect(applyOfferOperationPatch(completed, { phase: "adding" })).toBeNull();
    expect(canTransitionOfferOperation("cancelled", "completed")).toBe(false);
  });

  it("timestamps a complete discovery without turning unknown into zero", () => {
    const checking = {
      ...createOfferOperation("citi", "run-3"),
      phase: "checking" as const,
    };
    const ready = applyOfferOperationPatch(
      checking,
      {
        phase: "ready_to_add",
        cards: [
          {
            key: "card-0",
            name: "Citi card",
            lastDigits: "1234",
            availableCount: null,
            countStatus: "unknown",
          },
          {
            key: "card-1",
            name: "Citi card",
            lastDigits: "5678",
            availableCount: 0,
            countStatus: "complete",
          },
        ],
      },
      "2026-07-27T12:05:00.000Z",
    );
    expect(ready?.checkedAt).toBe("2026-07-27T12:05:00.000Z");
    expect(ready?.cards[0].availableCount).toBeNull();
    expect(ready?.cards[1].availableCount).toBe(0);
  });

  it("expires actionable counts after fifteen minutes", () => {
    const checkedAt = "2026-07-27T12:00:00.000Z";
    const state = {
      ...createOfferOperation("chase", "run-4", checkedAt),
      phase: "ready_to_add" as const,
      checkedAt,
      cards: [{
        key: "card-0",
        name: "Sapphire",
        lastDigits: "1234",
        availableCount: 18,
        countStatus: "complete" as const,
      }],
    };
    const checkedAtMs = new Date(checkedAt).getTime();
    expect(isOfferResultFresh(state, checkedAtMs + OFFER_RESULT_FRESHNESS_MS)).toBe(true);
    expect(isOfferResultFresh(state, checkedAtMs + OFFER_RESULT_FRESHNESS_MS + 1)).toBe(false);
  });

  it("reports partial cancellation instead of a generic cancelled label", () => {
    const state = {
      ...createOfferOperation("amex", "run-5"),
      phase: "cancelled" as const,
      total: 18,
      added: 6,
      remaining: 12,
      cancelled: true,
    };
    expect(getOfferOperationStatusText(state)).toBe("Stopped · 6 added, 12 not attempted");
  });

  it("does not flash a terminal save failure while recovery is still settling", () => {
    const updatedAt = "2026-07-28T22:37:41.000Z";
    const state = {
      ...createOfferOperation("chase", "run-save", updatedAt),
      phase: "completed" as const,
      updatedAt,
      saveStatus: "failed" as const,
      saveError: "Couldn’t queue the nextcard save for retry.",
    };
    const updatedAtMs = new Date(updatedAt).getTime();
    expect(getOfferSaveStatusText(state, updatedAtMs + 1_000)).toBe(
      "finishing save to nextcard",
    );
    expect(
      getOfferSaveStatusText(
        state,
        updatedAtMs + OFFER_SAVE_FAILURE_GRACE_MS,
      ),
    ).toBe("Couldn’t queue the nextcard save for retry.");
  });

  it("recognizes the automatic save-and-refresh handoff", () => {
    const completed = {
      ...createOfferOperation("chase", "run-continue"),
      phase: "completed" as const,
      cards: [{
        key: "card-0",
        name: "Sapphire",
        lastDigits: "1234",
        availableCount: 10,
        countStatus: "complete" as const,
      }],
      selectedCardKeys: ["card-0"],
      added: 1,
    };

    expect(isOfferCompletionContinuing({
      ...completed,
      saveStatus: "saving",
    })).toBe(true);
    expect(isOfferCompletionContinuing({
      ...completed,
      saveStatus: "saved",
    })).toBe(true);
    expect(isOfferCompletionContinuing({
      ...completed,
      saveStatus: "queued_for_retry",
    })).toBe(false);
    expect(isOfferCompletionContinuing({
      ...completed,
      selectedCardKeys: [],
      saveStatus: "saved",
    })).toBe(false);
  });

  it("normalizes corrupt persisted snapshots safely", () => {
    const snapshot = normalizeOfferOperationSnapshot({
      active: { runId: 123 },
      history: {
        chase: {
          ...createOfferOperation("chase", "run-6"),
          phase: "not-a-phase",
          cards: [{ key: "card-0", name: "Sapphire", availableCount: -1 }],
        },
      },
    });
    expect(snapshot.active).toBeNull();
    expect(snapshot.history.chase?.phase).toBe("interrupted");
    expect(snapshot.history.chase?.cards[0].availableCount).toBeNull();
  });
});
