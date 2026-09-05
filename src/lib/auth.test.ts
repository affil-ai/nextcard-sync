import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuth } from "./auth";

const storageRemove = vi.fn();

beforeEach(() => {
  storageRemove.mockReset();
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => ({
          nextcard_auth: { token: "old-token" },
          pendingDetectedOfferSyncs: [{ runId: "legacy" }],
          pendingOfferActivationCompletions: [{ offerId: "offer-1" }],
          "offerUrlCache::account-a::member-a::1": {},
          "detectedOfferUrlCache::account-a::member-a::1": {},
          "pendingOfferSyncs::account-a::member-a::1": [],
          "pendingDetectedOfferSyncs::account-a::member-a::1": [],
          unrelatedPreference: true,
        })),
        remove: storageRemove,
      },
    },
  });
});

describe("clearAuth", () => {
  it("removes every account-scoped offer cache and retry queue", async () => {
    await clearAuth();

    const removed: unknown = storageRemove.mock.calls[0]?.[0];
    if (!Array.isArray(removed)) throw new Error("Expected removed storage keys");
    expect(removed).toEqual(expect.arrayContaining([
      "nextcard_auth",
      "pendingDetectedOfferSyncs",
      "pendingOfferActivationCompletions",
      "offerUrlCache::account-a::member-a::1",
      "detectedOfferUrlCache::account-a::member-a::1",
      "pendingOfferSyncs::account-a::member-a::1",
      "pendingDetectedOfferSyncs::account-a::member-a::1",
    ]));
    expect(removed).not.toContain("unrelatedPreference");
  });
});
