import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "./auth";
import {
  retryPendingOfferSyncs,
  syncOffersToNextCard,
  type OfferSyncPayload,
} from "./sync-offers-to-nextcard";

vi.mock("./auth", () => ({
  getAuth: vi.fn(),
}));

const payload: OfferSyncPayload = {
  runId: "run-123",
  issuer: "chase",
  issuerCardId: "card-123",
  issuerCardName: "Sapphire",
  issuerCardLastDigits: "1234",
  offers: [{
    issuerOfferId: "offer-1",
    merchantName: "Example",
    offerValue: "$5 back",
    category: null,
    expirationDate: null,
    rewardType: "flat_cash",
    rewardAmount: 5,
    rewardCurrency: "cash",
    maxReward: 5,
    minSpend: null,
    merchantUrl: "https://example.com",
    merchantLogoUrl: null,
    redemptionChannel: "online",
    enrolledAt: "2026-07-28T12:00:00.000Z",
  }],
};

const storageGet = vi.fn();
const storageSet = vi.fn();

beforeEach(() => {
  storageGet.mockReset();
  storageSet.mockReset();
  vi.mocked(getAuth).mockReset();
  vi.mocked(getAuth).mockResolvedValue({
    token: "token",
    name: "Test User",
    email: "test@example.com",
    signedInAt: "2026-07-28T12:00:00.000Z",
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
  });
});

describe("syncOffersToNextCard", () => {
  it("keeps a successful remote save successful when the local cache write fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        offerMap: {
          "example.com": [{
            merchantName: "Example",
            offerValue: "$5 back",
            cardName: "Sapphire",
            cardLastDigits: "1234",
            expirationDate: null,
            issuer: "chase",
            rewardType: "flat_cash",
            rewardAmount: 5,
          }],
        },
      }),
    })));
    storageSet.mockRejectedValue(new Error("storage quota exceeded"));

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "saved",
      error: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("queues an authentication failure with its run id for retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid or revoked token" }),
    })));
    storageGet.mockResolvedValue({ pendingOfferSyncs: [] });
    storageSet.mockResolvedValue(undefined);

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "queued_for_retry",
      error: "Invalid or revoked token",
    });
    expect(storageSet).toHaveBeenCalledWith({
      pendingOfferSyncs: [expect.objectContaining({ runId: "run-123" })],
    });
  });

  it("returns an actionable error when the retry payload cannot be stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid or revoked token" }),
    })));
    storageGet.mockResolvedValue({ pendingOfferSyncs: [] });
    storageSet.mockRejectedValue(new Error("storage quota exceeded"));

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "failed",
      error: "Couldn’t queue the nextcard save for retry. Reload the extension and try again.",
    });
  });
});

describe("retryPendingOfferSyncs", () => {
  it("returns saved run ids so operation status can recover after retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
    storageGet.mockImplementation(async (key: string) => (
      key === "pendingOfferSyncs" ? { pendingOfferSyncs: [payload] } : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs()).resolves.toEqual({
      savedRunIds: ["run-123"],
      remainingRunIds: [],
    });
    expect(storageSet).toHaveBeenCalledWith({ pendingOfferSyncs: [] });
  });
});
