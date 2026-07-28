import { describe, expect, it } from "vitest";
import { parseCapitalOneTravelCreditSnapshot } from "./capitalone";

describe("parseCapitalOneTravelCreditSnapshot", () => {
  it("keeps the annual entitlement when the credit is fully redeemed", () => {
    expect(parseCapitalOneTravelCreditSnapshot({
      topLines: [
        "$0.00",
        "Annual travel credit",
        "Renews Sep 4, 2026",
        "Available to spend on travel",
        "$0.00",
      ],
      activityLines: [
        "VENTURE X...9917 ANNUAL TRAVEL CREDIT REDEMPTION",
        "$300.00",
        "Sep 5, 2025",
        "VENTURE X...9917 ANNUAL TRAVEL CREDIT",
        "Redeemed Feb 6, 2026",
        "+ $300.00",
      ],
    })).toEqual({
      remaining: 0,
      total: 300,
      period: "Renews Sep 4, 2026",
    });
  });

  it("calculates a partially used annual credit from the grant and balance", () => {
    expect(parseCapitalOneTravelCreditSnapshot({
      topLines: [
        "Annual travel credit",
        "Renews Jan 1, 2027",
        "Available to spend on travel",
        "$125.50",
      ],
      activityLines: [
        "VENTURE X...1234 ANNUAL TRAVEL CREDIT",
        "+ $300.00",
      ],
    })).toEqual({
      remaining: 125.5,
      total: 300,
      period: "Renews Jan 1, 2027",
    });
  });

  it("falls back to the displayed annual amount when no activity is available", () => {
    expect(parseCapitalOneTravelCreditSnapshot({
      topLines: [
        "$300.00",
        "Annual travel credit",
        "Available to spend on travel",
        "$300.00",
      ],
      activityLines: [],
    })).toEqual({
      remaining: 300,
      total: 300,
      period: null,
    });
  });
});
