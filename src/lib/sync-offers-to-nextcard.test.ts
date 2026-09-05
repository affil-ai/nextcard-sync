import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "./auth";
import {
  getCurrentHouseholdOperationScope,
  isLegacyHouseholdOperationMode,
} from "./household-context";
import {
  retryPendingDetectedOfferSyncs,
  retryPendingOfferSyncs,
  pullOfferUrlCache,
  syncDetectedOffersToNextCard,
  syncOffersToNextCard,
  type DetectedOfferSyncPayload,
  type OfferSyncPayload,
} from "./sync-offers-to-nextcard";

vi.mock("./auth", () => ({
  getAuth: vi.fn(),
  getAuthGeneration: vi.fn(() => 0),
}));

vi.mock("./household-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./household-context")>();
  return {
    ...actual,
    getCurrentHouseholdOperationScope: vi.fn(),
    isLegacyHouseholdOperationMode: vi.fn(),
  };
});

const householdScope = {
  accountScopeId: "account:owner-a",
  memberId: "member-primary",
  memberDisplayName: "Vishal",
  memberLifecycleVersion: 1,
  contextRevision: "revision-1",
};
const enrolledStorageKey =
  "pendingOfferSyncs::account%3Aowner-a::member-primary::1";
const detectedStorageKey =
  "pendingDetectedOfferSyncs::account%3Aowner-a::member-primary::1";

const payload: OfferSyncPayload = {
  runId: "run-123",
  scope: householdScope,
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
  scope: householdScope,
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
  vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue(householdScope);
  vi.mocked(isLegacyHouseholdOperationMode).mockResolvedValue(false);
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "0.8.1" }),
    },
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
      },
    },
  });
});

describe("syncOffersToNextCard", () => {
  it("keeps ordinary accounts on the legacy offer route and cache", async () => {
    vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue(null);
    vi.mocked(isLegacyHouseholdOperationMode).mockResolvedValue(true);
    storageGet.mockResolvedValue({});
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncOffersToNextCard({ ...payload, scope: null })).resolves.toEqual({
      status: "saved",
      error: null,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/extension/offers-sync"),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          "X-Nextcard-Protocol-Version": "2",
        }),
      }),
    );
    expect(storageSet).toHaveBeenCalledWith({
      offerUrlCache: {
        "example.com": [expect.objectContaining({ merchantName: "Example" })],
      },
    });
  });

  it("sends the frozen household target to the v2 backend request", async () => {
    vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue(householdScope);
    let requestBody: BodyInit | null | undefined;
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      requestBody = init?.body;
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    storageGet.mockResolvedValue({});
    storageSet.mockResolvedValue(undefined);

    await syncOffersToNextCard({ ...payload, scope: householdScope });

    expect(JSON.parse(String(requestBody))).toMatchObject({
      memberId: "member-primary",
      contextRevision: "revision-1",
      memberLifecycleVersion: 1,
    });
    expect(JSON.parse(String(requestBody))).not.toHaveProperty("scope");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/extension/v2/offers-sync"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcard-Extension-Version": "0.8.1",
          "X-Nextcard-Protocol-Version": "2",
        }),
      }),
    );
  });

  it("writes a household offer map only to that member lifecycle cache", async () => {
    vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue(householdScope);
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
    storageSet.mockResolvedValue(undefined);

    await expect(syncOffersToNextCard({ ...payload, scope: householdScope }))
      .resolves.toEqual({ status: "saved", error: null });

    expect(storageSet).toHaveBeenCalledWith({
      "offerUrlCache::account%3Aowner-a::member-primary::1": {
        "example.com": [expect.objectContaining({ merchantName: "Example" })],
      },
      "detectedOfferUrlCache::account%3Aowner-a::member-primary::1": {},
    });
    expect(storageSet.mock.calls[0]?.[0]).not.toHaveProperty("offerUrlCache");
  });

  it("stops an in-flight save when the selected member changed", async () => {
    vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue({
      ...householdScope,
      memberId: "member-secondary",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncOffersToNextCard({ ...payload, scope: householdScope }))
      .resolves.toEqual({
        status: "failed",
        error: "stale_offer_operation",
      });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("fails closed when the authenticated account scope cannot be resolved", async () => {
    vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "failed",
      error: "stale_offer_operation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not repopulate an old member cache after a switch during the request", async () => {
    vi.mocked(getCurrentHouseholdOperationScope)
      .mockResolvedValueOnce(householdScope)
      .mockResolvedValueOnce({
        ...householdScope,
        memberId: "member-secondary",
      });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        offerMap: { "example.com": [] },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncOffersToNextCard({ ...payload, scope: householdScope }))
      .resolves.toEqual({ status: "saved", error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storageSet).not.toHaveBeenCalled();
  });

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
    storageGet.mockResolvedValue({ [enrolledStorageKey]: [] });
    storageSet.mockResolvedValue(undefined);

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "queued_for_retry",
      error: "Invalid or revoked token",
    });
    expect(storageSet).toHaveBeenCalledWith({
      [enrolledStorageKey]: [expect.objectContaining({ runId: "run-123" })],
    });
  });

  it("does not queue a terminal household scope rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        ok: false,
        code: "member_offer_writes_disabled",
      }),
    })));

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "failed",
      error: "member_offer_writes_disabled",
    });
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("returns an actionable error when the retry payload cannot be stored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid or revoked token" }),
    })));
    storageGet.mockResolvedValue({ [enrolledStorageKey]: [] });
    storageSet.mockRejectedValue(new Error("storage quota exceeded"));

    await expect(syncOffersToNextCard(payload)).resolves.toEqual({
      status: "failed",
      error: "Couldn’t queue the nextcard save for retry. Reload the extension and try again.",
    });
  });

  it("does not recreate an enrolled retry queue after logout", async () => {
    let resolveResponse: ((value: {
      ok: boolean;
      status: number;
      json: () => Promise<object>;
    }) => void) | undefined;
    const response = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<object>;
    }>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);

    const result = syncOffersToNextCard(payload);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.mocked(getAuth).mockResolvedValue(null);
    resolveResponse?.({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid or revoked token" }),
    });

    await expect(result).resolves.toEqual({
      status: "failed",
      error: "Couldn’t queue the nextcard save for retry. Reload the extension and try again.",
    });
    expect(storageSet).not.toHaveBeenCalled();
  });
});

describe("retryPendingOfferSyncs", () => {
  it("does not replay a queued payload for a different household scope", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const otherScope = { ...householdScope, memberId: "member-secondary" };
    const scopedKey = enrolledStorageKey;
    const scopedPayload = { ...payload, scope: otherScope };
    storageGet.mockImplementation(async (key: string) => (
      key === scopedKey ? { [scopedKey]: [scopedPayload] } : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: [],
      failedRunIds: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageSet).toHaveBeenCalledWith({ [scopedKey]: [] });
  });

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
      key === enrolledStorageKey
        ? { [enrolledStorageKey]: [payload, secondCardPayload] }
        : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: ["run-123"],
      failedRunIds: [],
    });
    expect(storageSet).toHaveBeenCalledWith({
      [enrolledStorageKey]: [secondCardPayload],
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
      key === enrolledStorageKey
        ? { [enrolledStorageKey]: [payload, secondCardPayload] }
        : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: ["run-123"],
      remainingRunIds: [],
      failedRunIds: [],
    });
    expect(storageSet).toHaveBeenCalledWith({ [enrolledStorageKey]: [] });
  });

  it("drops an enrolled retry after a terminal member-scope failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ code: "context_stale" }),
    })));
    storageGet.mockImplementation(async (key: string) => (
      key === enrolledStorageKey ? { [enrolledStorageKey]: [payload] } : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: [],
      failedRunIds: ["run-123"],
    });
    expect(storageSet).toHaveBeenCalledWith({ [enrolledStorageKey]: [] });
  });

  it("treats a terminal card failure as dominant over a transient card in the same run", async () => {
    const secondCardPayload = {
      ...payload,
      issuerCardId: "card-456",
      issuerCardName: "Freedom",
      issuerCardLastDigits: "4567",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({ code: "context_stale" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: "try again" }),
      });
    vi.stubGlobal("fetch", fetchMock);
    storageGet.mockImplementation(async (key: string) => (
      key === enrolledStorageKey
        ? { [enrolledStorageKey]: [payload, secondCardPayload] }
        : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: [],
      failedRunIds: ["run-123"],
    });
    expect(storageSet).toHaveBeenCalledWith({ [enrolledStorageKey]: [] });
  });

  it("removes a transient detected payload when the enrolled half of its run fails terminally", async () => {
    const sameRunDetectedPayload = {
      ...detectedPayload,
      runId: "run-123",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string) => (
      input.includes("offers-sync")
        ? {
            ok: false,
            status: 409,
            json: async () => ({ code: "context_stale" }),
          }
        : {
            ok: false,
            status: 503,
            json: async () => ({ error: "try again" }),
          }
    )));
    storageGet.mockImplementation(async (key: string) => {
      if (key === enrolledStorageKey) {
        return { [enrolledStorageKey]: [payload] };
      }
      if (key === detectedStorageKey) {
        return { [detectedStorageKey]: [sameRunDetectedPayload] };
      }
      return {};
    });
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: [],
      failedRunIds: ["run-123"],
    });
    expect(storageSet).toHaveBeenCalledWith({ [detectedStorageKey]: [] });
  });

  it("keeps successful retries pending when the queue update cannot be persisted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
    storageGet.mockImplementation(async (key: string) => (
      key === enrolledStorageKey ? { [enrolledStorageKey]: [payload] } : {}
    ));
    storageSet.mockImplementation(async (values: Record<string, unknown>) => {
      if (enrolledStorageKey in values) {
        throw new Error("storage quota exceeded");
      }
    });

    await expect(retryPendingOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: [],
      remainingRunIds: ["run-123"],
      failedRunIds: [],
    });
  });

  it("does not lose a newly queued save while retry persistence is finishing", async () => {
    const nextPayload = { ...payload, runId: "run-456", issuerCardId: "card-456" };
    const backing: Record<string, unknown> = { [enrolledStorageKey]: [payload] };
    storageGet.mockImplementation(async (key: string) => ({ [key]: backing[key] }));
    storageSet.mockImplementation(async (values: Record<string, unknown>) => {
      Object.assign(backing, values);
    });
    let resolveRetry: ((value: { ok: boolean; json: () => Promise<object> }) => void) | undefined;
    const retryResponse = new Promise<{ ok: boolean; json: () => Promise<object> }>((resolve) => {
      resolveRetry = resolve;
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => retryResponse)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: "Invalid or revoked token" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const retry = retryPendingOfferSyncs(householdScope);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const newSave = syncOffersToNextCard(nextPayload);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveRetry?.({ ok: true, json: async () => ({}) });

    await expect(Promise.all([retry, newSave])).resolves.toEqual([
      { savedRunIds: ["run-123"], remainingRunIds: [], failedRunIds: [] },
      { status: "queued_for_retry", error: "Invalid or revoked token" },
    ]);
    expect(backing[enrolledStorageKey]).toEqual([nextPayload]);
  });
});

describe("syncDetectedOffersToNextCard", () => {
  it("keeps ordinary accounts on the legacy detected-offer route", async () => {
    vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue(null);
    vi.mocked(isLegacyHouseholdOperationMode).mockResolvedValue(true);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncDetectedOffersToNextCard({
      ...detectedPayload,
      scope: null,
    })).resolves.toBe("saved");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/extension/offers-detected"),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          "X-Nextcard-Protocol-Version": "2",
        }),
      }),
    );
  });

  it("sends the frozen household target to the v2 detected-offer route", async () => {
    let requestBody: BodyInit | null | undefined;
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      requestBody = init?.body;
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncDetectedOffersToNextCard(detectedPayload)).resolves.toBe("saved");

    expect(JSON.parse(String(requestBody))).toMatchObject({
      memberId: "member-primary",
      contextRevision: "revision-1",
      memberLifecycleVersion: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/extension/v2/offers-detected"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcard-Extension-Version": "0.8.1",
          "X-Nextcard-Protocol-Version": "2",
        }),
      }),
    );
  });

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
    storageGet.mockResolvedValue({ [detectedStorageKey]: [] });
    storageSet.mockResolvedValue(undefined);

    await expect(syncDetectedOffersToNextCard(detectedPayload)).resolves.toBe("queued_for_retry");
    expect(storageSet).toHaveBeenCalledWith({
      [detectedStorageKey]: [detectedPayload],
    });
  });

  it("does not queue a detected save rejected for a stale member context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, code: "context_stale" }),
    })));

    await expect(syncDetectedOffersToNextCard(detectedPayload)).resolves.toBe(
      "failed",
    );
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it("does not recreate a detected retry queue after logout", async () => {
    let resolveResponse: ((value: {
      ok: boolean;
      status: number;
      json: () => Promise<object>;
    }) => void) | undefined;
    const response = new Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<object>;
    }>((resolve) => { resolveResponse = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal("fetch", fetchMock);

    const result = syncDetectedOffersToNextCard(detectedPayload);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.mocked(getAuth).mockResolvedValue(null);
    resolveResponse?.({
      ok: false,
      status: 401,
      json: async () => ({ error: "Invalid or revoked token" }),
    });

    await expect(result).resolves.toBe("failed");
    expect(storageSet).not.toHaveBeenCalled();
  });
});

describe("pullOfferUrlCache", () => {
  it("keeps ordinary accounts on the legacy offer pull and cache", async () => {
    vi.mocked(getCurrentHouseholdOperationScope).mockResolvedValue(null);
    vi.mocked(isLegacyHouseholdOperationMode).mockResolvedValue(true);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ offers: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    storageSet.mockResolvedValue(undefined);

    await pullOfferUrlCache(null);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/extension/offers-pull"),
      expect.objectContaining({
        headers: expect.not.objectContaining({
          "X-Nextcard-Protocol-Version": "2",
        }),
      }),
    );
    expect(storageSet).toHaveBeenCalledWith({
      offerUrlCache: {},
      detectedOfferUrlCache: {},
    });
  });

  it("pulls and stores offers for the frozen household member scope", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ offers: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    storageSet.mockResolvedValue(undefined);

    await pullOfferUrlCache(householdScope);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        "/extension/v2/offers-pull?memberId=member-primary&contextRevision=revision-1&memberLifecycleVersion=1",
      ),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Nextcard-Extension-Version": "0.8.1",
          "X-Nextcard-Protocol-Version": "2",
        }),
      }),
    );
    expect(storageSet).toHaveBeenCalledWith({
      "offerUrlCache::account%3Aowner-a::member-primary::1": {},
      "detectedOfferUrlCache::account%3Aowner-a::member-primary::1": {},
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
      key === detectedStorageKey
        ? { [detectedStorageKey]: [detectedPayload] }
        : {}
    ));
    storageSet.mockResolvedValue(undefined);

    await expect(retryPendingDetectedOfferSyncs(householdScope)).resolves.toEqual({
      savedRunIds: ["detected-run-123"],
      remainingRunIds: [],
      failedRunIds: [],
    });
    expect(storageSet).toHaveBeenCalledWith({ [detectedStorageKey]: [] });
  });
});
