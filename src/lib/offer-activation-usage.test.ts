import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FREE_MONTHLY_OFFER_ACTIVATION_LIMIT,
  capOfferEnrollmentTotal,
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
