import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerBofaOffers } from "./bofa-offers";
import { bofaPortalRequest } from "./bofa-portal-api";
import { runInNewContext } from "node:vm";
import { createMessageRouter } from "./core/message-router";
import { createRuntimeStateStore } from "./core/runtime-state";
import { createOfferOperationStore } from "./offer-operation-store";
import { createOfferOperationCoordinator } from "./offer-operation-coordinator";
import { providerRegistry } from "../providers/provider-registry";

const mocks = vi.hoisted(() => ({
  generation: 1,
  reserve: vi.fn(),
  record: vi.fn(),
  pull: vi.fn(),
}));
vi.mock("../lib/auth", () => ({
  getAuth: async () => ({
    token: "nextcard-test-token",
    email: "fixture@example.com",
  }),
  getAuthGeneration: () => mocks.generation,
}));
vi.mock("../lib/household-context", () => ({
  getCurrentHouseholdOperationScope: async () => null,
  isLegacyHouseholdOperationMode: async () => true,
  parseHouseholdOperationScope: () => undefined,
  householdOperationScopesMatch: () => false,
  getHouseholdScopedStorageKey: (key: string) => key,
}));
vi.mock("../lib/extension-profile", () => ({
  getStoredExtensionProfile: async () => ({ accountLevel: "free" }),
}));
vi.mock("../lib/offer-activation-usage", () => ({
  reserveOfferActivations: mocks.reserve,
  recordOfferActivations: mocks.record,
}));
vi.mock("../lib/sync-offers-to-nextcard", () => ({
  pullOfferUrlCache: mocks.pull,
}));

const portalId = `v1:${"a".repeat(64)}`;
let listener: (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (response: unknown) => void,
) => boolean | undefined;
let activated = false;
const execute = vi.fn();
const replySchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  state: z
    .object({
      runId: z.string(),
      phase: z.string(),
      added: z.number(),
      offers: z.array(
        z.object({ issuerOfferId: z.string(), action: z.string() }),
      ),
    })
    .nullable()
    .optional(),
});
const issuerOffer = (id: string) => ({
  offer_id: id,
  merchant_name: `Merchant ${id}`,
  headline: "5% cash back",
  type: "CARD_LINKED",
  activation_required: id === "2",
  activation_type: id === "2" ? "CLICK" : null,
  activation_triggers: id === "2" ? ["OFFER_DETAILS_CLICK"] : null,
  is_activated: id === "2" && activated,
  activation_expires_at:
    id === "2" && activated ? "2099-01-01T00:00:00Z" : null,
  description: "Details",
  terms_and_conditions: "Use an eligible card",
  reward_type: "PERCENTAGE",
  reward_rate: 5,
  reward_value: 0,
  reward_tiers: [],
  display_currency: "CASH",
  offer_mode: "ONLINE",
});
function send(message: object) {
  return new Promise<unknown>((resolve) =>
    listener(message, { id: "fixture-extension" }, resolve),
  ).then((raw) => replySchema.parse(raw));
}

beforeEach(() => {
  activated = false;
  mocks.generation = 1;
  vi.clearAllMocks();
  mocks.reserve.mockResolvedValue({ ok: true, granted: 100 });
  mocks.record.mockResolvedValue(undefined);
  mocks.pull.mockResolvedValue(undefined);
  const storage: Record<string, unknown> = {};
  execute.mockImplementation(
    async (args: { args: [string, string | null, number | string | null] }) => {
      const [kind, , input] = args.args;
      let data: unknown = null;
      if (kind === "search")
        data = { total: 2, offers: [{ offer_id: "1" }, { offer_id: "2" }] };
      if (kind === "details" && typeof input === "string")
        data = { offer: issuerOffer(input) };
      if (kind === "activate") {
        activated = true;
        data = { ok: true };
      }
      return [
        { result: { portalId, hasLocationContext: true, status: 200, data } },
      ];
    },
  );
  vi.stubGlobal("__CONVEX_SITE_URL__", "https://nextcard-test.example");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = z
        .object({ batch: z.object({ offers: z.array(z.unknown()) }) })
        .parse(JSON.parse(typeof init.body === "string" ? init.body : "{}"));
      return new Response(
        JSON.stringify({ ok: true, saved: body.batch.offers.length }),
        { status: 200 },
      );
    }),
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "fixture-extension",
      getManifest: () => ({ version: "0.8.5" }),
      onMessage: {
        addListener: (callback: typeof listener) => {
          listener = callback;
        },
      },
    },
    tabs: {
      update: vi.fn(async () => ({ id: 7 })),
      create: async () => ({
        id: 7,
        url: "https://deals.merchant-rewards.com/search",
      }),
      query: async () => [
        { id: 7, active: true, url: "https://deals.merchant-rewards.com/" },
      ],
      get: async () => ({
        id: 7,
        status: "complete",
        url: "https://deals.merchant-rewards.com/",
      }),
    },
    scripting: { executeScript: execute },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage[key] }),
        set: async (values: Record<string, unknown>) =>
          Object.assign(storage, values),
        remove: async (key: string) => {
          delete storage[key];
        },
      },
    },
  });
  registerBofaOffers();
});

async function ready() {
  await send({ type: "BOFA_PORTAL_CHECK" });
  await vi.waitFor(async () =>
    expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe(
      "ready",
    ),
  );
  const state = (await send({ type: "BOFA_PORTAL_STATUS" })).state;
  if (!state) throw new Error("Missing BofA state");
  return state;
}
describe("BofA portal operation boundaries", () => {
  it("returns BofA progress and saves offers when the general message listener is also registered", async()=>{
    const unused=async()=>{throw new Error("Unexpected unrelated handler call");};
    const store=createOfferOperationStore();
    const general=createMessageRouter({providerRegistry,stateStore:createRuntimeStateStore(),
      syncHandlers:{generic:unused,atmos:unused,"chase-v1":unused,amex:unused,capitalone:unused,hyatt:unused,bilt:unused},
      cancelRun:unused,startSignIn:unused,signOut:unused,getCachedAuth:unused,recordConsent:unused,
      pushToNextCard:unused,deleteFromNextCard:unused,offerOperations:store,
      offerCoordinator:createOfferOperationCoordinator(store,async()=>null,async()=>true),
      travelSyncCoordinator:{start:unused,getStatus:unused,cancel:unused,resetResult:unused}});
    registerBofaOffers();
    function broadcast(message:Record<string,unknown>) {
      return new Promise<unknown>(resolve=>{
        listener(message,{id:"fixture-extension"},resolve);
        general(message,{id:"fixture-extension"},resolve);
      }).then(raw=>replySchema.parse(raw));
    }
    const started=await broadcast({type:"BOFA_PORTAL_CHECK"});
    expect(started.state?.phase).toBe("checking");
    await vi.waitFor(async()=>expect((await broadcast({type:"BOFA_PORTAL_STATUS"})).state?.phase).toBe("ready"));
    expect((await broadcast({type:"BOFA_PORTAL_STATUS"})).state?.offers).toHaveLength(2);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/extension/portal-offers-sync"),expect.anything());
  });

  it("uses the signed-in banking tab to open Deals without opening another sign-in tab", async () => {
    const bankTab = {
      ...(await chrome.tabs.get(7)),
      url: "https://secure.bankofamerica.com/myaccounts/signin/signIn.go",
    };
    vi.spyOn(chrome.tabs, "query")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([bankTab]);
    const create = vi.spyOn(chrome.tabs, "create");
    registerBofaOffers();
    const response = await send({ type: "BOFA_PORTAL_CHECK" });
    expect(response.ok).toBe(true);
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
      url: "https://secure.bankofamerica.com/myaccounts/brain/redirect.go?request_locale=en-us&target=offers&source=rewardDeals&location=myRewards",
      active: true,
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      url: "https://deals.merchant-rewards.com/search",
      active: true,
    });
    await vi.waitFor(async () =>
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe(
        "ready",
      ),
    );
  });

  it("runs the serialized issuer bridge without extension closures and keeps the issuer token in that page", async () => {
    const token = `fixture.${Buffer.from(JSON.stringify({ user_id: "synthetic-user", publisher_id: "synthetic-publisher", exp: 4102444800 })).toString("base64url")}.signature`;
    const requests: Array<{ path: string; headers: unknown; body: unknown }> =
      [];
    const result: unknown = await runInNewContext(
      `(${bofaPortalRequest.toString()})("search", null, 24)`,
      {
        window: {
          __nextcardBofaLocation: {
            latitude: 1,
            longitude: 2,
            sessionHash: Buffer.from(
              await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(token),
              ),
            ).toString("hex"),
          },
        },
        location: { origin: "https://deals.merchant-rewards.com", search: "" },
        localStorage: {
          getItem: (key: string) =>
            key === "LS_TOKEN"
              ? token
              : key === "geo_fallback_location"
                ? JSON.stringify({ latitude: 1, longitude: 2 })
                : null,
        },
        URLSearchParams,
        atob,
        TextEncoder,
        crypto,
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: async (path: string, init: RequestInit) => {
          requests.push({
            path,
            headers: init.headers,
            body: JSON.parse(typeof init.body === "string" ? init.body : "{}"),
          });
          return new Response(JSON.stringify({ offers: [], total: 0 }), {
            status: 200,
          });
        },
      },
    );
    expect(result).toMatchObject({
      status: 200,
      data: { offers: [], total: 0 },
    });
    expect(requests).toMatchObject([
      {
        path: "/api/offers-search",
        body: { apply_filter: {}, page_offset: 24, page_size: 24 },
      },
    ]);
    expect(requests[0]?.body).toEqual({apply_filter:{},proximity_target:{latitude:1,longitude:2},sort_by:"merchant_name_asc",page_size:24,page_offset:24});
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("synthetic-user");
  });

  it("rejects automatic-ready selections and confirms only the selected click activation", async () => {
    const state = await ready();
    expect(state.offers).toEqual([
      { issuerOfferId: "1", action: "ready" },
      { issuerOfferId: "2", action: "activate" },
    ]);
    expect(
      await send({
        type: "BOFA_PORTAL_ACTIVATE",
        runId: state.runId,
        ids: ["1"],
      }),
    ).toMatchObject({ ok: false });
    expect(mocks.reserve).not.toHaveBeenCalled();
    await send({
      type: "BOFA_PORTAL_ACTIVATE",
      runId: state.runId,
      ids: ["2"],
    });
    await vi.waitFor(async () =>
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe(
        "completed",
      ),
    );
    expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.added).toBe(1);
    expect(
      execute.mock.calls
        .filter((call) => call[0].args[0] === "activate")
        .map((call) => call[0].args[2]),
    ).toEqual(["2"]);
    expect(mocks.record).toHaveBeenCalledWith(
      "fixture@example.com",
      expect.any(String),
      1,
    );
  });
  it("does not activate from a previous nextcard account", async () => {
    const state = await ready();
    mocks.generation++;
    expect(
      await send({
        type: "BOFA_PORTAL_ACTIVATE",
        runId: state.runId,
        ids: ["2"],
      }),
    ).toMatchObject({ ok: false });
    expect(
      execute.mock.calls.some((call) => call[0].args[0] === "activate"),
    ).toBe(false);
    expect((await send({ type: "BOFA_PORTAL_STATUS" })).state).toBeNull();
  });
});
