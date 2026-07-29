import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuth } from "./auth";
import { pushToNextCard } from "./sync-to-nextcard";

vi.mock("./auth", () => ({
  getAuth: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getAuth).mockReset();
  vi.mocked(getAuth).mockResolvedValue({
    token: "token",
    name: "Test User",
    email: "test@example.com",
    signedInAt: "2026-07-28T12:00:00.000Z",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pushToNextCard", () => {
  it("turns Hilton remaining qualification values into full progress targets", async () => {
    let requestBody: unknown;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    }));

    await expect(pushToNextCard("hilton", {
      pointsBalance: 100_000,
      eliteStatus: "Gold",
      nightsThisYear: 10,
      nightsToNextTier: 15,
      staysThisYear: 4,
      staysToNextTier: 6,
      spendThisYear: "$1,250",
      spendToNextTier: "$750",
      nextTierName: "Diamond",
      lifetimeNights: 100,
      memberName: "Example Member",
      memberNumber: "12345678",
      memberSince: "2020",
    })).resolves.toEqual({ ok: true });

    expect(requestBody).toMatchObject({
      provider: "hilton",
      providerData: {
        qualifyingMetrics: [
          {
            label: "Nights This Year",
            current: 10,
            target: 25,
            unit: "nights",
          },
          {
            label: "Stays This Year",
            current: 4,
            target: 10,
            unit: "stays",
          },
          {
            label: "Eligible Spend",
            current: 1250,
            target: 2000,
            unit: "$",
          },
        ],
      },
    });
  });
});
