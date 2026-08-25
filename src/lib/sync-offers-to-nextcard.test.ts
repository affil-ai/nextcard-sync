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
const alarmsCreate = vi.fn();

beforeEach(() => {
  storageGet.mockReset();
  storageSet.mockReset();
  alarmsCreate.mockReset();
  alarmsCreate.mockResolvedValue(undefined);
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
    alarms: {
      create: alarmsCreate,
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

  it("schedules bounded cache refreshes when domain enrichment is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ enrichmentPending: true }),
    })));
    storageGet.mockResolvedValue({});
    storageSet.mockResolvedValue(undefined);

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "saved",
      error: null,
    });
    expect(alarmsCreate).toHaveBeenCalledTimes(2);
    expect(alarmsCreate).toHaveBeenNthCalledWith(
      1,
      "refreshEnrichedOfferUrlCacheSoon",
      { delayInMinutes: 1 },
    );
    expect(alarmsCreate).toHaveBeenNthCalledWith(
      2,
      "refreshEnrichedOfferUrlCacheFollowUp",
      { delayInMinutes: 5 },
    );
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

  it("refreshes the cache after asynchronous detected-offer enrichment", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ enrichmentPending: true }),
    })));

    await expect(syncDetectedOffersToNextCard(detectedPayload)).resolves.toBe(
      "saved",
    );
    expect(alarmsCreate).toHaveBeenCalledTimes(2);
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
