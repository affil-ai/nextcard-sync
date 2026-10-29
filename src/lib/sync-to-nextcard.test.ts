import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAuth } from "./auth";
import { pushToNextCard } from "./sync-to-nextcard";

const hiltonData = {
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
};

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

    await expect(pushToNextCard("hilton", hiltonData)).resolves.toEqual({ ok: true });

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

  it("preserves the assigned member when preflight detects an identity collision", async () => {
    let preflightBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      preflightBody = JSON.parse(String(init?.body));
      return {
        ok: false,
        status: 409,
        json: async () => ({
          code: "identity_conflict",
          existingMemberId: "member-primary",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(pushToNextCard("hilton", hiltonData, {
      target: {
        accountScopeId: "account-a",
        memberId: "member-a",
        memberDisplayName: "Family member",
        memberLifecycleVersion: 1,
        provider: "hilton",
        contextRevision: "revision-1",
        operationId: "operation-1",
      },
    })).resolves.toMatchObject({
      ok: false,
      code: "identity_conflict",
      existingMemberId: "member-primary",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(preflightBody).toMatchObject({
      memberId: "member-a",
      identityEvidence: { memberNumber: "12345678" },
      input: {
        memberNumber: "****5678",
      },
    });
  });

  it("commits only after the household preflight succeeds", async () => {
    const requestedUrls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requestedUrls.push(url);
      bodies.push(JSON.parse(String(init?.body)));
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    }));

    await expect(pushToNextCard("hilton", hiltonData, {
      target: {
        accountScopeId: "account-a",
        memberId: "member-a",
        memberDisplayName: "Family member",
        memberLifecycleVersion: 1,
        provider: "hilton",
        contextRevision: "revision-1",
        operationId: "operation-1",
      },
      identityConfirmed: true,
    })).resolves.toEqual({ ok: true });

    expect(requestedUrls.map((url) => new URL(url).pathname)).toEqual([
      "/extension/v2/preflight",
      "/extension/v2/sync",
    ]);
    expect(bodies[0]).toMatchObject({ memberId: "member-a", operationId: "operation-1", identityConfirmed: true,
      identityEvidence: { memberNumber: "12345678" }, input: { memberNumber: "****5678" } });
    expect(bodies[1]).toMatchObject({ operationId: "operation-1", input: { memberNumber: "****5678" } });
    expect(JSON.stringify(bodies[1])).not.toContain("12345678");
  });

  it("requires a second explicit confirmation when conversion appears at commit", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requestedUrls.push(url);
      const pathname = new URL(url).pathname;
      return pathname.endsWith("/preflight")
        ? {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
          }
        : {
            ok: false,
            status: 409,
            json: async () => ({ code: "manual_conversion_required" }),
          };
    }));

    await expect(pushToNextCard("hilton", hiltonData, {
      target: {
        accountScopeId: "account-a",
        memberId: "member-a",
        memberDisplayName: "Family member",
        memberLifecycleVersion: 1,
        provider: "hilton",
        contextRevision: "revision-1",
        operationId: "operation-1",
      },
      identityConfirmed: true,
    })).resolves.toMatchObject({
      ok: false,
      code: "manual_conversion_required",
      manualConversionRequired: true,
    });
    expect(requestedUrls.map((url) => new URL(url).pathname)).toEqual([
      "/extension/v2/preflight",
      "/extension/v2/sync",
    ]);
  });
});

it("preserves product changes awaiting review separately from saved cards", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ cardSync: { created: 0, existing: 2, productChangesToReview: 1 } }),
  })));
  await expect(pushToNextCard("hilton", hiltonData)).resolves.toMatchObject({
    ok: true,
    cardSync: { created: 0, existing: 2, productChangesToReview: 1 },
  });
});

it("ignores malformed card counts without failing an otherwise successful sync", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ cardSync: { created: 0, existing: -2, productChangesToReview: "one" } }),
  })));
  const result = await pushToNextCard("hilton", hiltonData);
  expect(result.ok).toBe(true);
  expect(result.cardSync).toBeUndefined();
});


it("sends only redacted companion codes and nested copies to the database", async () => {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  await expect(pushToNextCard("atmos", {
    availablePoints: 500, statusPoints: 10, statusLevel: null,
    memberName: null, memberNumber: "123456789", rewards: [],
    discounts: [{ name: "Companion fare", code: "FARE-ABC123", details: "Use FARE-ABC123 for 123456789", expiration: null }],
  })).resolves.toEqual({ ok: true });
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toContain("FARE-ABC123");
  expect(bodies[0]).not.toContain("123456789");
  expect(JSON.parse(bodies[0])).toMatchObject({
    memberNumber: "*****6789",
    rawProviderData: { discounts: [{ code: "*******C123", details: "Use *******C123 for *****6789" }] },
    providerData: { raw: { discounts: [{ code: "*******C123" }] } }
  });
});

it("does not commit a household save if its run is cancelled during preflight", async () => {
  let current = true;
  let finishPreflight: (() => void) | undefined;
  const preflightReady = new Promise<void>(resolve => { finishPreflight = resolve; });
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(new URL(url).pathname);
    if (url.endsWith("/preflight")) await preflightReady;
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  const pending = pushToNextCard("hilton", hiltonData, {
    target: { accountScopeId: "owner", memberId: "mom", memberDisplayName: "Mom", memberLifecycleVersion: 1,
      provider: "hilton", contextRevision: "revision-1", operationId: "mom-run" },
    identityConfirmed: true,
    isContextCurrent: async () => current,
  });
  await vi.waitFor(() => expect(requests).toEqual(["/extension/v2/preflight"]));
  current = false;
  finishPreflight?.();
  await expect(pending).resolves.toMatchObject({ ok: false, error: "sync_cancelled" });
  expect(requests).toEqual(["/extension/v2/preflight"]);
});

it("sends no request after the sync context has already changed", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(pushToNextCard("hilton", hiltonData, { isContextCurrent: async () => false }))
    .resolves.toMatchObject({ ok: false, error: "sync_cancelled" });
  expect(fetchMock).not.toHaveBeenCalled();
});
