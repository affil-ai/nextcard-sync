import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FREE_MONTHLY_OFFER_ACTIVATION_LIMIT,
  capOfferEnrollmentTotal,
  getOfferActivationUsage,
  recordOfferActivations,
  reserveOfferActivations,
  retryPendingOfferActivationCompletions,
} from "./offer-activation-usage";

let stored: Record<string, unknown>;

beforeEach(() => {
  stored = {
    nextcard_auth: {
      token: "test-token",
      name: "Test User",
      email: "test@example.com",
      signedInAt: new Date().toISOString(),
    },
  };
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => {
          Object.assign(stored, value);
        }),
        remove: vi.fn(async (key: string) => {
          delete stored[key];
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offer activation monthly allowance", () => {
  it("caps a Free enrollment to the remaining allowance", () => {
    expect(capOfferEnrollmentTotal(150, 100)).toBe(100);
    expect(capOfferEnrollmentTotal(59, 8)).toBe(8);
    expect(capOfferEnrollmentTotal(20, 0)).toBe(0);
  });

  it("does not cap Pro enrollments", () => {
    expect(capOfferEnrollmentTotal(150, null)).toBe(150);
  });

  it("uses the intended Free monthly limit", () => {
    expect(FREE_MONTHLY_OFFER_ACTIVATION_LIMIT).toBe(100);
  });

  it("fails closed when the backend cannot reserve the run", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const result = await reserveOfferActivations(
      "test@example.com",
      false,
      "run-offline",
      25,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "quota_unavailable",
      requested: 25,
      granted: 0,
    });
  });

  it("uses the live Pro allowance and grant despite an exhausted cached Free plan", async () => {
    const month = new Date().toISOString().slice(0, 7);
    stored.offerActivationUsageByAccount = {
      "test@example.com": { month, used: 100, countedRunIds: [] },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ month, accountLevel: "pro", used: 628, limit: null, remaining: null, granted: 30 }),
    }));
    expect(await getOfferActivationUsage("test@example.com", false)).toMatchObject({
      accountLevel: "pro", used: 628, limit: null, remaining: null,
    });
    expect(await reserveOfferActivations("test@example.com", false, "pro-run", 30)).toMatchObject({
      ok: true, accountLevel: "pro", granted: 30, limit: null,
    });
  });

  it("keeps the server's Free cap even when the cached plan is Pro", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ month: "2026-10", accountLevel: "free", used: 95, limit: 100, remaining: 0, granted: 5 }),
    }));
    expect(await reserveOfferActivations("test@example.com", true, "free-run", 30)).toMatchObject({
      ok: true, accountLevel: "free", granted: 5, limit: 100,
    });
  });

  it.each([
    { accountLevel: "pro", limit: null, remaining: null, error: "offer_run_unavailable" },
    { accountLevel: "free", limit: 100, remaining: 20, error: "offer_run_unavailable" },
    { accountLevel: "free", limit: 100, remaining: 0, error: "monthly_offer_limit_reached" },
  ])("classifies a rejected $accountLevel run with remaining=$remaining", async ({ error, ...allowance }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({ month: "2026-10", used: 80, granted: 0, ...allowance }),
    }));
    expect(await reserveOfferActivations("test@example.com", false, "ended-run", 30)).toMatchObject({
      ok: false, granted: 0, error, ...allowance,
    });
  });

  it("keeps failed completion reports and retries them later", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await recordOfferActivations("test@example.com", "run-complete", 12);
    expect(stored.pendingOfferActivationCompletions).toEqual([
      expect.objectContaining({
        account: "test@example.com",
        runId: "run-complete",
        added: 12,
      }),
    ]);

    await retryPendingOfferActivationCompletions();

    expect(stored.pendingOfferActivationCompletions).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
