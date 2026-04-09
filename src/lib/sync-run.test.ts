import { describe, expect, it } from "vitest";
import { createSyncRunRegistry, SyncRunCancelledError } from "./sync-run";

describe("createSyncRunRegistry", () => {
  it("marks only the current attempt as cancelled and rejects late completion checks", () => {
    const registry = createSyncRunRegistry();

    registry.beginRun("aa", "attempt-1");
    expect(registry.shouldAcceptMessage("aa", "attempt-1")).toBe(true);

    const cancelledRun = registry.markCancelled("aa");

    expect(cancelledRun?.attemptId).toBe("attempt-1");
    expect(registry.shouldAcceptMessage("aa", "attempt-1")).toBe(false);
    expect(() => registry.assertRunActive("aa", "attempt-1")).toThrow(SyncRunCancelledError);
  });

  it("tracks the owned sync tab separately from observed user tabs", () => {
    const registry = createSyncRunRegistry();

    registry.beginRun("hyatt", "attempt-1");
    registry.recordObservedTab("hyatt", "attempt-1", 11, { owned: true });
    const run = registry.recordObservedTab("hyatt", "attempt-1", 29, { owned: false });

    expect(run?.ownedTabId).toBe(11);
    expect(Array.from(run?.observedTabIds ?? [])).toEqual([11, 29]);
  });

  it("blocks finalize guards after cancel so done state and pushes cannot proceed", () => {
    const registry = createSyncRunRegistry();

    registry.beginRun("chase", "attempt-1");
    registry.markCancelled("chase");

    const finalize = () => {
      registry.assertRunActive("chase", "attempt-1");
      return "would-finish";
    };

    expect(finalize).toThrow(SyncRunCancelledError);
  });

  it("invalidates old attempt messages after a new sync starts", () => {
    const registry = createSyncRunRegistry();

    registry.beginRun("amex", "attempt-1");
    registry.markCancelled("amex");
    registry.beginRun("amex", "attempt-2");

    expect(registry.shouldAcceptMessage("amex", "attempt-1")).toBe(false);
    expect(registry.shouldAcceptMessage("amex", "attempt-2")).toBe(true);
    expect(() => registry.assertRunActive("amex", "attempt-1")).toThrow(SyncRunCancelledError);
  });
});
