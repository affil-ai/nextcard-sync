import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkDoorDashTab,
  readDoorDashSession,
  registerDoorDashTest,
} from "./doordash";
import { doorDashQueries } from "../providers/doordash";
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
  expect(fetcher).toHaveBeenCalledTimes(5);
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
