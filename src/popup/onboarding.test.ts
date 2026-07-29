import { describe, expect, it } from "vitest";
import { getOnboardingCompletionAction } from "./onboarding";

describe("onboarding completion", () => {
  it("sends Replay Guide directly into Rewards", () => {
    expect(getOnboardingCompletionAction(true, true)).toEqual({
      label: "Set up Rewards",
      destination: "rewards",
    });
  });

  it("keeps the first-time Offers handoff unchanged", () => {
    expect(getOnboardingCompletionAction(false, true)).toEqual({
      label: "Continue to Offers",
      destination: "offers",
    });
    expect(getOnboardingCompletionAction(false, false)).toEqual({
      label: "Continue with nextcard",
      destination: "offers",
    });
  });
});
