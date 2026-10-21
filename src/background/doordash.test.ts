import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkDoorDashTab,
  readDoorDashSession,
  registerDoorDashTest,
} from "./doordash";
import { createMessageRouter } from "./core/message-router";
import { createRuntimeStateStore } from "./core/runtime-state";
import { createOfferOperationStore } from "./offer-operation-store";
import { createOfferOperationCoordinator } from "./offer-operation-coordinator";
import { providerRegistry } from "../providers/provider-registry";
import { doorDashQueries, doorDashReadSchema, normalizeDoorDashReads } from "../providers/doordash";
import * as auth from "../lib/auth";
import * as household from "../lib/household-context";

beforeEach(() => {
  vi.stubGlobal("document", { cookie: "csrftoken=test-csrf" });
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockReads(
  options: { changeAccount?: boolean; fail?: boolean; noCarts?: boolean } = {},
) {
  let subscriptionReads = 0;
  const fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (options.fail)
      return new Response("verification required", { status: 403 });
    if (path === "/home") return new Response('<a href="/store/example-123/">Store</a>');
    if (path.includes("get_active_subscription_status")) {
      subscriptionReads++;
      return Response.json({
        plan_id: "test-plan",
        consumer_subscription_id:
          options.changeAccount && subscriptionReads > 1
            ? "second-account"
            : "first-account",
        subscription_status: "ACTIVE",
        is_eligible_for_benefits: true,
      });
    }
    if (path.includes("partner_plan_benefit_validation"))
      return Response.json({
        consumer_subscription_plan_benefit_membership_type:
          "ChaseSapphireReserve",
      });
    const body: unknown = JSON.parse(String(init.body));
    if (typeof body !== "object" || body === null || !("operationName" in body))
      throw new Error("Missing operation");
    if (body.operationName === "listCarts")
      return Response.json({
        data: {
          listCarts: options.noCarts
            ? []
            : [
                {
                  id: "cart",
                  subtotal: 1500,
                  creator: { id: "consumer" },
                  restaurant: { id: "store" },
                },
              ],
        },
      });
    if (body.operationName === "subscriptionInformation")
      return Response.json({
        data: {
          subscriptionInformation: {
            subscriptionInfo: { subscriptionPlan: { id: "test-plan" } },
          },
        },
      });
    return Response.json({
      data: { getPlacements: { placements: { placementSections: [] } } },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

it("checks a grocery cart even when three restaurant carts appear first", async () => {
  const fetcher = mockReads();
  const original = fetcher.getMockImplementation();
  if (!original) throw new Error("Missing mocked DoorDash reads");
  fetcher.mockImplementation(async (path: string, init: RequestInit) => {
    if (path === "/graphql/listCarts") {
      return Response.json({ data: { listCarts: [1, 2, 3, 4].map((index) => ({
        id: `cart-${index}`,
        subtotal: 1500,
        isConvenienceCart: index === 4,
        creator: { id: "consumer" },
        restaurant: { id: `store-${index}` },
      })) } });
    }
    return original(path, init);
  });
  await readDoorDashSession(doorDashQueries);
  const checkouts = fetcher.mock.calls.map(([, init]) => String(init.body))
    .filter((body) => body.includes('"location":"CHECKOUT"'));
  expect(checkouts).toHaveLength(3);
  expect(checkouts.some((body) => body.includes('"storeId":"store-4"'))).toBe(true);
});

it("discovers offered campaigns from account-local stores without a cart", async () => {
  const fetcher = mockReads({ noCarts: true });
  const original = fetcher.getMockImplementation();
  if (!original) throw new Error("Missing mocked reads");
  fetcher.mockImplementation(async (path: string, init: RequestInit) => {
    if (path === "/home") return new Response('<a href="/convenience/store/123/">Market</a><a href="/store/market-456/">Market 2</a>');
    if (path === "/graphql/getPlacements" && String(init.body).includes('"location":"STORE"')) {
      return Response.json({ data: { getPlacements: { placements: { placementSections: [{ placementModels: [{
        title: { copy: "$10 off Chase monthly benefit" }, description: { copy: "Apply at checkout" },
        custom: { campaign_id: "grocery-campaign" },
      }] }] } } } });
    }
    return original(path, init);
  });
  const result = await readDoorDashSession(doorDashQueries);
  expect(result.reads.filter((row) => row.source.startsWith("placements:store:"))).toHaveLength(2);
  const normalized = normalizeDoorDashReads(doorDashReadSchema.array().parse(result.reads), new Date().toISOString(), result.accountKey);
  expect(normalized.campaigns).toEqual([expect.objectContaining({ campaignId: "grocery-campaign", frequency: "monthly" })]);
  expect(normalized.contexts).toEqual([
    { source: "placements:store:1", nonRestaurant: true, validationPassed: false },
    { source: "placements:store:2", nonRestaurant: false, validationPassed: false },
  ]);
  expect(fetcher.mock.calls.some(([path]) => path.includes("partner_plan_benefit_validation"))).toBe(false);
});

it.each(["placements", "carts"])("rejects malformed %s instead of treating missing data as an exhausted campaign", async (part) => {
  const fetcher = mockReads({ noCarts: true });
  const original = fetcher.getMockImplementation();
  if (!original) throw new Error("Missing mocked reads");
  fetcher.mockImplementation(async (path: string, init: RequestInit) => {
    if (path === (part === "placements" ? "/graphql/getPlacements" : "/graphql/listCarts"))
      return Response.json({ data: {} });
    return original(path, init);
  });
  const result = await readDoorDashSession(doorDashQueries);
  expect(result.reads.some((read) => read.source === (part === "placements" ? "placements:wallet" : "carts") && read.status === "error")).toBe(true);
  if (part === "carts") expect(fetcher.mock.calls.some(([path]) => path === "/home")).toBe(false);
});

it("only runs the captured read operations and hashes the account identifier", async () => {
  const fetcher = mockReads();
  const result = await readDoorDashSession(doorDashQueries);
  expect(result.accountKey).toHaveLength(16);
  expect(result.accountKey).not.toContain("first-account");
  expect(fetcher).toHaveBeenCalledTimes(7);
  for (const [path, init] of fetcher.mock.calls) {
    expect(init.credentials).toBe("include");
    if (init.method === "POST") {
      const body = String(init.body);
      expect(body).toContain('"query":"query ');
      expect(body).not.toMatch(
        /mutation|addPromo|updateCart|placeOrder|deleteCart/,
      );
    } else
      expect(path).toMatch(
        /get_active_subscription_status|partner_plan_benefit_validation/,
      );
  }
});
it("does not invent carts when there is no checkout context", async () => {
  const fetcher = mockReads({ noCarts: true });
  const result = await readDoorDashSession(doorDashQueries);
  expect(fetcher).toHaveBeenCalledTimes(7);
  expect(
    result.reads.some((read) => read.source.startsWith("placements:checkout")),
  ).toBe(false);
});
it("rejects mixed account results when the login changes during a check", async () => {
  mockReads({ changeAccount: true });
  await expect(readDoorDashSession(doorDashQueries)).rejects.toThrow(
    "account changed",
  );
});
it("reports verification failures without returning HTML or secrets", async () => {
  mockReads({ fail: true });
  const result = await readDoorDashSession(doorDashQueries);
  expect(result.accountKey).toBeNull();
  expect(result.reads.every((read) => read.status === "error")).toBe(true);
  expect(JSON.stringify(result)).not.toContain("verification required");
  expect(JSON.stringify(result)).not.toContain("test-csrf");
});
it("refuses to inject into an unrelated origin", async () => {
  const executeScript = vi.fn();
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async () => ({ url: "https://example.com/" })) },
    scripting: { executeScript },
  });
  await expect(checkDoorDashTab(1)).rejects.toThrow("doordash.com");
  expect(executeScript).not.toHaveBeenCalled();
});
it("rejects anonymous query responses instead of reporting a successful sync", async () => {
  vi.stubGlobal("chrome", {
    tabs: { get: vi.fn(async () => ({ url: "https://www.doordash.com/" })) },
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            reads: [
              {
                source: "membership",
                status: "ok",
                data: { subscriptionInformation: null },
              },
            ],
            accountKey: null,
          },
        },
      ]),
    },
  });
  await expect(checkDoorDashTab(1)).rejects.toThrow(
    "Could not read your membership",
  );
});
it("allows the dedicated popup listener to reply without exposing checks to content scripts", () => {
  const addListener = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener },
    },
  });
  registerDoorDashTest();
  const listener = addListener.mock.calls[0]?.[0];
  const respond = vi.fn();
  expect(
    listener(
      { type: "DOORDASH_TEST_CHECK", tabId: 1 },
      { id: "test", tab: { id: 1 }, url: "https://www.doordash.com/" },
      respond,
    ),
  ).toBe(false);
  expect(respond).not.toHaveBeenCalled();
  listener(
    { type: "DOORDASH_TEST_CHECK", tabId: "bad" },
    { id: "test", url: "chrome-extension://test/src/popup/popup.html" },
    respond,
  );
  expect(respond).toHaveBeenCalledWith({
    ok: false,
    error: "Select a DoorDash tab first.",
  });
});
it("blocks saving when the selected Nextcard profile changes after capture", async () => {
  vi.spyOn(auth, "getAuth").mockResolvedValue({
    token: "synthetic-nextcard-token",
    name: null,
    email: null,
    signedInAt: "now",
  });
  const scope = vi
    .spyOn(household, "getCurrentHouseholdOperationScope")
    .mockResolvedValue(null);
  vi.spyOn(household, "isLegacyHouseholdOperationMode").mockResolvedValue(true);
  const addListener = vi.fn();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener },
    },
    tabs: { get: vi.fn(async () => ({ url: "https://www.doordash.com/" })) },
    scripting: {
      executeScript: vi.fn(async () => [
        {
          result: {
            reads: [
              {
                source: "subscription",
                status: "ok",
                data: { plan_id: "plan", subscription_status: "ACTIVE" },
              },
            ],
            accountKey: "abcdef1234567890",
          },
        },
      ]),
    },
  });
  registerDoorDashTest();
  const listener = addListener.mock.calls[0]?.[0];
  const sender = {
    id: "test",
    url: "chrome-extension://test/src/popup/popup.html",
  };
  const captured: unknown = await new Promise((resolve) =>
    listener({ type: "DOORDASH_TEST_CHECK", tabId: 1 }, sender, resolve),
  );
  expect(captured).toMatchObject({ ok: true });
  scope.mockResolvedValue({
    accountScopeId: "household",
    memberId: "other-member",
    memberDisplayName: "Other",
    memberLifecycleVersion: 1,
    contextRevision: "new",
  });
  const response: unknown = await new Promise((resolve) =>
    listener(
      { type: "DOORDASH_TEST_SAVE", userCardId: "card" },
      sender,
      resolve,
    ),
  );
  expect(response).toMatchObject({
    ok: false,
    error: expect.stringContaining("profile changed"),
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("rechecks the DoorDash account and sends the explicit period total through the authenticated backend", async () => {
  vi.spyOn(auth, "getAuth").mockResolvedValue({
    token: "synthetic-token",
    name: null,
    email: null,
    signedInAt: "now",
  });
  vi.spyOn(household, "getCurrentHouseholdOperationScope").mockResolvedValue(
    null,
  );
  vi.spyOn(household, "isLegacyHouseholdOperationMode").mockResolvedValue(true);
  const addListener = vi.fn();
  const executeScript = vi.fn(async () => [
    {
      result: {
        reads: [
          {
            source: "subscription",
            status: "ok",
            data: { plan_id: "plan", subscription_status: "ACTIVE" },
          },
        ],
        accountKey: "abcdef1234567890",
      },
    },
  ]);
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ ok: true, amountUsed: 20 }),
  );
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "test",
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: { addListener },
    },
    tabs: {
      get: vi.fn(async () => ({
        url: "https://www.doordash.com/consumer/payment",
      })),
    },
    scripting: { executeScript },
  });
  registerDoorDashTest();
  const listener = addListener.mock.calls[0]?.[0];
  const sender = {
    id: "test",
    url: "chrome-extension://test/src/popup/popup.html",
  };
  await new Promise((resolve) =>
    listener({ type: "DOORDASH_TEST_CHECK", tabId: 1 }, sender, resolve),
  );
  const confirmation = {
    cardCreditId: "credit-a",
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    uses: 2,
  };
  const result = await new Promise((resolve) =>
    listener(
      { type: "DOORDASH_USAGE_CONFIRM", userCardId: "card-a", confirmation },
      sender,
      resolve,
    ),
  );
  expect(result).toEqual({ ok: true, amountUsed: 20 });
  expect(executeScript).toHaveBeenCalledTimes(2);
  const body: unknown = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body).toMatchObject({
    operation: "confirm-usage",
    userCardId: "card-a",
    confirmation,
    snapshot: { accountKey: "abcdef1234567890", planId: "plan" },
  });
});


it("leaves every DoorDash reply to its dedicated listener", () => {
  const unused = async () => { throw new Error("Unexpected unrelated handler"); };
  const store = createOfferOperationStore();
  const general = createMessageRouter({
    providerRegistry, stateStore: createRuntimeStateStore(),
    syncHandlers: { generic: unused, atmos: unused, "chase-v1": unused, amex: unused, capitalone: unused, hyatt: unused, bilt: unused },
    cancelRun: unused, startSignIn: unused, signOut: unused, getCachedAuth: unused,
    recordConsent: unused, pushToNextCard: unused, deleteFromNextCard: unused,
    offerOperations: store,
    offerCoordinator: createOfferOperationCoordinator(store, async () => null, async () => true),
    travelSyncCoordinator: { start: unused, getStatus: unused, cancel: unused, resetResult: unused },
  });
  const respond = vi.fn();
  for (const type of ["DOORDASH_TEST_CHECK", "DOORDASH_TEST_CARDS", "DOORDASH_TEST_SAVE", "DOORDASH_BENEFITS", "DOORDASH_USAGE_OPTIONS", "DOORDASH_USAGE_CONFIRM"]) {
    expect(general({ type }, { id: "test", url: "chrome-extension://test/src/popup/popup.html" }, respond)).toBe(false);
  }
  expect(respond).not.toHaveBeenCalled();
});
