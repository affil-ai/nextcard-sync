import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "./auth";
import {
  retryPendingDetectedOfferSyncs,
  retryPendingOfferSyncs,
  syncDetectedOffersToNextCard,
  syncOffersToNextCard,
  type DetectedOfferSyncPayload,
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

const detectedPayload: DetectedOfferSyncPayload = {
  runId: "detected-run-123",
  issuer: "amex",
  issuerCardId: "card-123",
  issuerCardName: "Amex Gold",
  issuerCardLastDigits: "1234",
  offers: [{
    issuerOfferId: "detected-offer-1",
    merchantName: "Constant Contact",
    offerValue: "$30 back",
    category: null,
    expirationDate: null,
    rewardType: "flat_cash",
    rewardAmount: 30,
    rewardCurrency: "cash",
    maxReward: 30,
    minSpend: null,
    merchantUrl: "https://constantcontact.com",
    merchantLogoUrl: null,
    redemptionChannel: "online",
    status: "detected",
    detectedAt: "2026-08-11T16:00:00.000Z",
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
  it("keeps a run pending until every same-run card payload is saved", async () => {
    const secondCardPayload = {
      ...payload,
      issuerCardId: "card-456",
      issuerCardName: "Freedom",
      issuerCardLastDigits: "4567",
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: "Temporarily unavailable" }),
      }));
    storageGet.mockImplementation(async (key: string) => (
      key === "pendingOfferSyncs"
        ? { pendingOfferSyncs: [payload, secondCardPayload] }
        : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs()).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: ["run-123"],
    });
    expect(storageSet).toHaveBeenCalledWith({
      pendingOfferSyncs: [secondCardPayload],
    });
  });

  it("returns a run as saved after every same-run card payload succeeds", async () => {
    const secondCardPayload = {
      ...payload,
      issuerCardId: "card-456",
      issuerCardName: "Freedom",
      issuerCardLastDigits: "4567",
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
    storageGet.mockImplementation(async (key: string) => (
      key === "pendingOfferSyncs"
        ? { pendingOfferSyncs: [payload, secondCardPayload] }
        : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs()).resolves.toEqual({
      savedRunIds: ["run-123"],
      remainingRunIds: [],
    });
    expect(storageSet).toHaveBeenCalledWith({ pendingOfferSyncs: [] });
  });

  it("keeps successful retries pending when the queue update cannot be persisted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
    storageGet.mockImplementation(async (key: string) => (
      key === "pendingOfferSyncs" ? { pendingOfferSyncs: [payload] } : {}
    ));
    storageSet.mockImplementation(async (values: Record<string, unknown>) => {
      if ("pendingOfferSyncs" in values) {
        throw new Error("storage quota exceeded");
      }
    });

    await expect(retryPendingOfferSyncs()).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: ["run-123"],
    });
  });
});

describe("syncDetectedOffersToNextCard", () => {
  it("serializes multi-card detected-offer saves", async () => {
    let resolveFirst: ((value: { ok: boolean; json: () => Promise<object> }) => void) | undefined;
    const firstResponse = new Promise<{ ok: boolean; json: () => Promise<object> }>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const first = syncDetectedOffersToNextCard(detectedPayload);
    const second = syncDetectedOffersToNextCard({
      ...detectedPayload,
      runId: "detected-run-456",
      issuerCardId: "card-456",
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFirst?.({ ok: true, json: async () => ({}) });

    await expect(Promise.all([first, second])).resolves.toEqual(["saved", "saved"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queues an authentication failure for a durable detected-offer retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid or revoked token" }),
    })));
    storageGet.mockResolvedValue({ pendingDetectedOfferSyncs: [] });
    storageSet.mockResolvedValue(undefined);

    await expect(syncDetectedOffersToNextCard(detectedPayload)).resolves.toBe("queued_for_retry");
    expect(storageSet).toHaveBeenCalledWith({
      pendingDetectedOfferSyncs: [detectedPayload],
    });
  });
});

describe("retryPendingDetectedOfferSyncs", () => {
  it("replays detected payloads and returns saved run ids", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
    storageGet.mockImplementation(async (key: string) => (
      key === "pendingDetectedOfferSyncs"
        ? { pendingDetectedOfferSyncs: [detectedPayload] }
        : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingDetectedOfferSyncs()).resolves.toEqual({
      savedRunIds: ["detected-run-123"],
      remainingRunIds: [],
    });
    expect(storageSet).toHaveBeenCalledWith({ pendingDetectedOfferSyncs: [] });
  });
});
