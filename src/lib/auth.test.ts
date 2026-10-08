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

it("does not erase a new login when verification of an old token fails late", async () => {
  const { setAuth, verifyAuth } = await import("./auth");
  let current: unknown = { token: "old-token" };
  let finish!: (response: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
  vi.mocked(chrome.storage.local.get).mockImplementation(async () => ({ nextcard_auth: current }));
  chrome.storage.local.set = vi.fn(async (values) => { current = values.nextcard_auth; });
  const verification = verifyAuth();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await setAuth({ token: "new-token", name: null, email: null, signedInAt: "now" });
  finish({ json: async () => ({ valid: false }) });
  await verification;
  expect(storageRemove).not.toHaveBeenCalled();
  expect(current).toMatchObject({ token: "new-token" });
});

it("preserves credentials when bounded verification times out", async () => {
  const { verifyAuth } = await import("./auth");
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new Error("timeout")));
  })));
  try {
    const verification = verifyAuth();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(timeout).toHaveBeenCalledWith(10_000);
    controller.abort();
    expect(await verification).toBe(true);
    expect(storageRemove).not.toHaveBeenCalled();
  } finally {
    timeout.mockRestore();
  }
});
