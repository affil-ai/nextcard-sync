import { describe, expect, it } from "vitest";

import { summarizeSouthwestFlightCredits } from "./southwest-flight-credits";

describe("summarizeSouthwestFlightCredits", () => {
  it("reduces a noisy Southwest section to the verified credit count", () => {
    expect(
      summarizeSouthwestFlightCredits(
        "Sort by Amount (Highest) Expand all 5.01 Dollars $5.01 #A4UKWG LIMITED-TIME OFFER Earn 80,000 points.",
      ),
    ).toBe("1 flight credit");
  });

  it("deduplicates confirmation codes", () => {
    expect(
      summarizeSouthwestFlightCredits(
        "#A4UKWG $5.01 View details #A4UKWG Terms #B7C2DE $10.00",
      ),
    ).toBe("2 flight credits");
  });

  it("keeps the empty state concise", () => {
    expect(
      summarizeSouthwestFlightCredits(
        "You don't have any available flight credits right now.",
      ),
    ).toBe("No available flight credits");
  });

  it("drops unverified promotional copy", () => {
    expect(
      summarizeSouthwestFlightCredits(
        "LIMITED-TIME OFFER Earn 80,000 points. First checked bag is free.",
      ),
    ).toBeNull();
  });
});
