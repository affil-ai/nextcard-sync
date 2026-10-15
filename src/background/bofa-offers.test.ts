import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerBofaOffers } from "./bofa-offers";
import { bofaPortalRequest } from "./bofa-portal-api";
import { bofaPortalStateSchema } from "../providers/bofa-offers";
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
      reviewFinished: z.boolean().optional(),
      added: z.number(),
      discovered: z.number().optional(),
      checked: z.number().optional(),
      retryAt: z.number().optional(),
      skippedPages: z.number().optional(),
      error: z.string().nullable().optional(),
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
  it("reuses persisted details after a worker restart and only reads or saves new and changed offers", async () => {
    const bridge = execute.getMockImplementation();
    let revision = 1;
    let includeNew = false;
    execute.mockImplementation(async args => {
      const [kind,,id] = args.args;
      if (kind==="search") return [{result:{portalId,status:200,data:{
        total:includeNew ? 3 : 2,
        offers:(includeNew ? ["1","2","3"] : ["1","2"]).map(id=>({
          ...issuerOffer(id),offer_version:id==="1" ? revision : 1,updated_at:id==="1" ? revision : 1,
        })),
      }}}];
      if (kind==="details" && id==="1") return [{result:{portalId,status:200,data:{offer:{...issuerOffer(id),reward_rate:revision===1 ? 5 : 6}}}}];
      return bridge?.(args);
    });
    await ready();
    expect(execute.mock.calls.filter(([a])=>a.args[0]==="details")).toHaveLength(2);
    execute.mockClear();
    vi.mocked(fetch).mockClear();
    registerBofaOffers();
    await ready();
    expect(execute.mock.calls.some(([a])=>a.args[0]==="search")).toBe(true);
    expect(execute.mock.calls.filter(([a])=>a.args[0]==="details")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    revision = 2;
    includeNew = true;
    execute.mockClear();
    const state = await ready();
    expect(state.offers).toHaveLength(3);
    expect(execute.mock.calls.filter(([a])=>a.args[0]==="details").map(([a])=>a.args[2]).sort()).toEqual(["1","3"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const uploaded = z.object({batch:z.object({offers:z.array(z.object({issuerOfferId:z.string()}))})})
      .parse(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)));
    expect(uploaded.batch.offers.map(o=>o.issuerOfferId).sort()).toEqual(["1","3"]);
  });

  it.each(["portal", "profile", "sign-in", "age"])("does not reuse cached details across a changed %s", async boundary => {
    const bridge = execute.getMockImplementation();
    execute.mockImplementation(async args => args.args[0]==="search"
      ? [{result:{portalId,status:200,data:{total:2,offers:["1","2"].map(id=>({...issuerOffer(id),offer_version:1,updated_at:1}))}}}]
      : bridge?.(args));
    await ready();
    const previous = z.object({bofa_portal_operation:z.object({
      state:bofaPortalStateSchema,scope:z.unknown(),authFingerprint:z.string(),portalId:z.string(),
    })}).parse(await chrome.storage.local.get("bofa_portal_operation")).bofa_portal_operation;
    if (boundary==="portal") previous.portalId=`v1:${"b".repeat(64)}`;
    if (boundary==="profile") previous.scope={memberId:"different-profile"};
    if (boundary==="sign-in") previous.authFingerprint="different-sign-in";
    if (boundary==="age") for (const meta of Object.values(previous.state.offerCacheMeta ?? {})) meta.readAt-=25*60*60*1000;
    await chrome.storage.local.set({bofa_portal_operation:previous});
    registerBofaOffers();
    execute.mockClear();
    await ready();
    expect(execute.mock.calls.filter(([a])=>a.args[0]==="details")).toHaveLength(2);
  });

  it("keeps acknowledged cache data if a later refresh is stopped before discovering offers", async () => {
    const bridge = execute.getMockImplementation();
    let limited = false;
    execute.mockImplementation(async args => args.args[0]==="search"
      ? [{result:limited ? {portalId,status:429,data:null} : {portalId,status:200,data:{total:2,offers:["1","2"].map(id=>({...issuerOffer(id),offer_version:1,updated_at:1}))}}}]
      : bridge?.(args));
    await ready();
    vi.useFakeTimers();
    try {
      limited=true;
      await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(0);
      await send({type:"BOFA_PORTAL_CANCEL"});
      await vi.advanceTimersByTimeAsync(5000);
    } finally {vi.useRealTimers();}
    limited=false;
    registerBofaOffers();
    execute.mockClear();
    vi.mocked(fetch).mockClear();
    await ready();
    expect(execute.mock.calls.filter(([a])=>a.args[0]==="details")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

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

  it("renews a near-expiry session before scanning", async () => {
    const bridge = execute.getMockImplementation();
    const create = vi.spyOn(chrome.tabs, "create");
    let sessions = 0;
    execute.mockImplementation(async (args) => {
      if (args.args?.[0] === "session") {
        sessions++;
        return [{ result: { portalId, hasLocationContext: true, expiresAt: Date.now() + (sessions === 1 ? 60000 : 1800000) } }];
      }
      return bridge?.(args);
    });
    await ready();
    expect(create.mock.calls.filter(([options]) => options.url?.includes("redirect.go"))).toHaveLength(1);
    expect(sessions).toBeGreaterThanOrEqual(2);
  });

  it.each(["unchanged expiry", "different account"])("rejects renewal with %s before reading offers", async (scenario) => {
    const bridge = execute.getMockImplementation();
    const expiry = Date.now() + 60000;
    let sessions = 0;
    execute.mockImplementation(async (args) => {
      if (args.args?.[0] === "session") {
        sessions++;
        return [{ result: { portalId: sessions > 1 && scenario === "different account" ? `v1:${"b".repeat(64)}` : portalId, expiresAt: expiry } }];
      }
      return bridge?.(args);
    });
    const response = await send({ type: "BOFA_PORTAL_CHECK" });
    expect(response.ok).toBe(false);
    expect(response.error).toMatch(scenario === "different account" ? /account changed/ : /did not renew/);
    expect(execute.mock.calls.some(([args]) => args.args?.[0] === "search")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps acknowledged details when reconnecting after a partial scan", async () => {
    const bridge = execute.getMockImplementation();
    let sessions = 0;
    let expired = false;
    execute.mockImplementation(async (args) => {
      const [kind,,input] = args.args;
      if (kind === "session") return [{ result: { portalId, hasLocationContext: true, expiresAt: Date.now() + ++sessions * 1800000 } }];
      if (kind === "search" && typeof input === "number") return [{ result: { portalId, status: 200, data: {
        total: 55,
        offers: Array.from({ length: Math.min(24, 55 - input) }, (_, index) => ({ ...issuerOffer(String(input + index + 1)), offer_version: 1, updated_at: 1 })),
      } } }];
      if (kind === "details" && input === "51" && !expired) {
        expired = true;
        return [{ result: { error: "Your BofA session expired. Sign in to BofA." } }];
      }
      return bridge?.(args);
    });
    await send({ type: "BOFA_PORTAL_CHECK" });
    await vi.waitFor(async () => expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("ready"));
    const state = (await send({ type: "BOFA_PORTAL_STATUS" })).state;
    expect(state?.offers).toHaveLength(55);
    for (let id = 1; id <= 50; id++)
      expect(execute.mock.calls.filter(([args]) => args.args[0] === "details" && args.args[2] === String(id))).toHaveLength(1);
  });

  it("reconnects once after expiry and stops if the renewed session also expires", async () => {
    const bridge = execute.getMockImplementation();
    const create = vi.spyOn(chrome.tabs, "create");
    let sessions = 0;
    execute.mockImplementation(async (args) => {
      if (args.args?.[0] === "session") {
        sessions++;
        return [{ result: { portalId, hasLocationContext: true, expiresAt: Date.now() + sessions * 1800000 } }];
      }
      if (args.args?.[0] === "search") return [{ result: { error: "Your BofA session expired. Sign in to BofA." } }];
      return bridge?.(args);
    });
    await send({ type: "BOFA_PORTAL_CHECK" });
    await vi.waitFor(async () => {
      const response = await send({ type: "BOFA_PORTAL_STATUS" });
      expect(response.state?.phase).toBe("failed");
      expect(create.mock.calls.filter(([options]) => options.url?.includes("redirect.go"))).toHaveLength(1);
      expect(execute.mock.calls.filter(([args]) => args.args?.[0] === "search")).toHaveLength(2);
    });
  });

  it("reconnects through BofA instead of reusing an expired portal tab", async () => {
    const create = vi.spyOn(chrome.tabs, "create");
    const response = await send({ type: "BOFA_PORTAL_SIGN_IN" });
    expect(response.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      url: "https://secure.bankofamerica.com/myaccounts/brain/redirect.go?request_locale=en-us&target=offers&source=rewardDeals&location=myRewards",
      active: true,
    });
    await vi.waitFor(async () =>
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("ready"),
    );
  });

  it("waits for login and redirects Accounts back to deals before scanning", async () => {
    vi.useFakeTimers();
    try {
      let loggedIn = false;
      let portalOpened = false;
      const bridge = execute.getMockImplementation();
      execute.mockImplementation(async (args) =>
        args.args ? bridge?.(args) : [{ result: loggedIn }],
      );
      vi.spyOn(chrome.tabs, "get").mockImplementation(async () => ({
        id: 7, status: "complete", index: 0, pinned: false,
        highlighted: true, windowId: 1, active: true, incognito: false,
        selected: true, discarded: false, autoDiscardable: true, groupId: -1,
        url: portalOpened
          ? "https://deals.merchant-rewards.com/search"
          : "https://secure.bankofamerica.com/myaccounts/signin/signIn.go",
      }));
      vi.mocked(chrome.tabs.update).mockImplementation(async () => {
        portalOpened = true;
        return chrome.tabs.get(7);
      });
      const reconnect = send({ type: "BOFA_PORTAL_SIGN_IN" });
      await vi.advanceTimersByTimeAsync(25000);
      expect(chrome.tabs.update).not.toHaveBeenCalled();
      loggedIn = true;
      await vi.advanceTimersByTimeAsync(3000);
      expect((await reconnect).state?.phase).toBe("checking");
      expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
        url: "https://secure.bankofamerica.com/myaccounts/brain/redirect.go?request_locale=en-us&target=offers&source=rewardDeals&location=myRewards",
        active: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("ready");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([200, 429])("handles issuer status %s inside the serialized bridge without exposing its token", async (status) => {
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
          return new Response(status === 200 ? JSON.stringify({ offers: [], total: 0 }) : "Rate limited", {
            status,
            headers: { "Retry-After": "2" },
          });
        },
      },
    );
    expect(result).toMatchObject(status === 200 ? {
      status: 200, data: { offers: [], total: 0 },
    } : { status: 429, data: null, retryAfterMs: 2000 });
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
  it("activates another subset after completion without rescanning or reactivating previous offers", async () => {
    let thirdActivated = false;
    const bridge = execute.getMockImplementation();
    execute.mockImplementation(async (args) => {
      const [kind, , input] = args.args;
      if (kind === "search") return [{ result: { portalId, status: 200, data: {
        total: 3, offers: [{ offer_id: "1" }, { offer_id: "2" }, { offer_id: "3" }],
      } } }];
      if (input === "3" && kind === "activate") {
        thirdActivated = true;
        return [{ result: { portalId, status: 200, data: { ok: true } } }];
      }
      if (input === "3" && kind === "details") return [{ result: { portalId, status: 200, data: {
        offer: { ...issuerOffer("2"), offer_id: "3", is_activated: thirdActivated },
      } } }];
      return bridge?.(args);
    });
    const state = await ready();
    for (const id of ["2", "3"]) {
      const started = await send({ type: "BOFA_PORTAL_ACTIVATE", runId: state.runId, ids: [id] });
      expect(started.ok).toBe(true);
      await vi.waitFor(async () => expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("completed"));
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.added).toBe(1);
    }
    expect(execute.mock.calls.filter(([args]) => args.args[0] === "activate").map(([args]) => args.args[2])).toEqual(["2", "3"]);
    expect((await send({ type: "BOFA_PORTAL_ACTIVATE", runId: state.runId, ids: ["2"] })).ok).toBe(false);
  });

  it("keeps read slots busy and reads the next batch while the previous save is pending", async () => {
    let releaseRead = () => {};
    let releaseSave = () => {};
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const reads: string[] = [];
    let activeReads = 0;
    let peakReads = 0;
    let saves = 0;
    const bridge = execute.getMockImplementation();
    const saveFetch = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (++saves === 1) await saveGate;
      return saveFetch(url, init);
    }));
    execute.mockImplementation(async (args) => {
      const [kind, , input] = args.args;
      if (kind === "search" && typeof input === "number") return [{ result: {
        portalId, status: 200, data: { total: 55, offers: Array.from(
          { length: Math.min(24, 55 - input) }, (_, i) => ({ offer_id: String(input + i + 1) }),
        ) },
      } }];
      if (kind !== "details") return bridge?.(args);
      reads.push(input);
      activeReads++;
      peakReads = Math.max(peakReads, activeReads);
      try {
        if (Number(input) <= 8) await readGate;
        return await bridge?.(args);
      } finally { activeReads--; }
    });
    await send({ type: "BOFA_PORTAL_CHECK" });
    try {
      await vi.waitFor(() => expect(reads).toHaveLength(8));
      releaseRead();
      await vi.waitFor(() => expect(saves).toBe(1));
      await vi.waitFor(() => expect(reads).toContain("51"));
      expect(peakReads).toBe(8);
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("checking");
    } finally {
      releaseRead();
      releaseSave();
      await vi.waitFor(async () => expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("ready"));
    }
    expect(new Set(reads).size).toBe(55);
    expect(reads).toHaveLength(55);
    expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.offers).toHaveLength(55);
    expect(saves).toBe(2);
  });

  it("keeps other read workers moving while one rate-limited offer waits five seconds", async () => {
    vi.useFakeTimers();
    const bridge = execute.getMockImplementation();
    const reads: Array<{id:string;time:number}> = [];
    let limited = false;
    execute.mockImplementation(async args => {
      const [kind,,id] = args.args;
      if (kind === "search") return [{result:{portalId,status:200,data:{
        total:12,offers:Array.from({length:12},(_,i)=>({offer_id:String(i+1)})),
      }}}];
      if (kind === "details" && typeof id === "string") {
        reads.push({id,time:Date.now()});
        if (id === "1" && !limited) {
          limited = true;
          return [{result:{portalId,status:429,data:null}}];
        }
      }
      return bridge?.(args);
    });
    try {
      const startedAt = Date.now();
      await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(0);
      expect(reads.map(r=>r.id)).toContain("12");
      expect(reads).toHaveLength(12);
      expect((await send({type:"BOFA_PORTAL_STATUS"})).state).toMatchObject({phase:"checking",checked:11});
      expect((await send({type:"BOFA_PORTAL_STATUS"})).state?.retryAt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(4999);
      expect(reads.filter(r=>r.id==="1")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads.filter(r=>r.id==="1").map(r=>r.time-startedAt)).toEqual([0,5000]);
      expect((await send({type:"BOFA_PORTAL_STATUS"})).state?.phase).toBe("ready");
      expect((await send({type:"BOFA_PORTAL_STATUS"})).state?.offers).toHaveLength(12);
    } finally {vi.useRealTimers();}
  });

  it("backs off a rate-limited read and does not silently skip it", async () => {
    vi.useFakeTimers();
    const bridge = execute.getMockImplementation();
    let attempts = 0;
    execute.mockImplementation(async args => {
      if (args.args[0] === "details" && args.args[2] === "1" && ++attempts < 3)
        return [{ result: { portalId, status: 429, data: null, retryAfterMs: 2000 } }];
      return bridge?.(args);
    });
    try {
      await send({ type: "BOFA_PORTAL_CHECK" });
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(4999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(5001);
      expect(attempts).toBe(3);
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("ready");
      expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.offers).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("resumes a rate-limited discovery page after longer cooldowns without restarting earlier pages", async () => {
    vi.useFakeTimers();
    const bridge = execute.getMockImplementation();
    let limitedAttempts = 0;
    execute.mockImplementation(async args => {
      const [kind, , offset] = args.args;
      if (kind !== "search" || typeof offset !== "number") return bridge?.(args);
      if (offset === 24 && ++limitedAttempts < 4)
        return [{ result: { portalId, status: 429, data: null, retryAfterMs: 45000 } }];
      return [{ result: { portalId, status: 200, data: {
        total: 48, offers: Array.from({length:24},(_,i)=>({offer_id:String(offset+i+1)})),
      } } }];
    });
    try {
      await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(0);
      const paused = (await send({type:"BOFA_PORTAL_STATUS"})).state;
      expect(paused).toMatchObject({phase:"checking",discovered:24,retryAt:Date.now()+45000});
      const runId = paused?.runId;
      await vi.advanceTimersByTimeAsync(44999);
      expect(limitedAttempts).toBe(1);
      await vi.advanceTimersByTimeAsync(90001);
      const finished = (await send({type:"BOFA_PORTAL_STATUS"})).state;
      expect(finished).toMatchObject({runId,phase:"ready",discovered:48});
      expect(finished?.retryAt).toBeUndefined();
      expect(finished?.offers).toHaveLength(48);
      expect(execute.mock.calls.filter(([a])=>a.args[0]==="search" && a.args[2]===0)).toHaveLength(1);
      expect(limitedAttempts).toBe(4);
    } finally { vi.useRealTimers(); }
  });

  it.each(["cancel", "account change"])("does not resume a paused scan after %s", async reason => {
    vi.useFakeTimers();
    const bridge = execute.getMockImplementation();
    execute.mockImplementation(async args => args.args[0] === "search"
      ? [{result:{portalId,status:429,data:null,retryAfterMs:45000}}]
      : bridge?.(args));
    try {
      await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(0);
      expect((await send({type:"BOFA_PORTAL_STATUS"})).state?.phase).toBe("checking");
      if (reason === "cancel") await send({type:"BOFA_PORTAL_CANCEL"});
      else mocks.generation++;
      await vi.advanceTimersByTimeAsync(60000);
      expect(execute.mock.calls.filter(([a])=>a.args[0]==="search")).toHaveLength(1);
      expect((await send({type:"BOFA_PORTAL_STATUS"})).state?.phase ?? null).toBe(reason === "cancel" ? "cancelled" : null);
    } finally { vi.useRealTimers(); }
  });

  it("does not let a cancelled cooldown overwrite a newer completed run", async () => {
    vi.useFakeTimers();
    const bridge = execute.getMockImplementation();
    let limited = true;
    execute.mockImplementation(async args => limited && args.args[0] === "search"
      ? [{result:{portalId,status:429,data:null,retryAfterMs:45000}}]
      : bridge?.(args));
    try {
      await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(0);
      await send({type:"BOFA_PORTAL_CANCEL"});
      limited = false;
      const next = await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(60000);
      const saved = z.object({bofa_portal_operation:z.object({state:z.object({runId:z.string(),phase:z.string()})})})
        .parse(await chrome.storage.local.get("bofa_portal_operation"));
      expect(saved.bofa_portal_operation.state).toMatchObject({runId:next.state?.runId,phase:"ready"});
    } finally { vi.useRealTimers(); }
  });

  it("saves readable offers after an incomplete discovery page instead of failing the run", async () => {
    vi.useFakeTimers();
    const bridge = execute.getMockImplementation();
    execute.mockImplementation(async args => {
      const [kind,,offset] = args.args;
      if (kind!=="search" || typeof offset!=="number") return bridge?.(args);
      return [{result:{portalId,status:200,data:{total:72,
        offers:Array.from({length:offset===24 ? 0 : 24},(_,i)=>({offer_id:String(offset+i+1)})),
      }}}];
    });
    try {
      await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(400);
      const state = (await send({type:"BOFA_PORTAL_STATUS"})).state;
      expect(state).toMatchObject({phase:"ready",skippedPages:1,error:"Some offers couldn't be checked. Your saved offers are still available."});
      expect(state?.offers).toHaveLength(48);
      expect(state?.offers.at(-1)?.issuerOfferId).toBe("72");
      expect(fetch).toHaveBeenCalled();
    } finally {vi.useRealTimers();}
  });

  it("bounds automatic retries if the issuer remains unavailable", async () => {
    vi.useFakeTimers();
    const bridge = execute.getMockImplementation();
    execute.mockImplementation(async args => args.args[0] === "search"
      ? [{result:{portalId,status:503,data:null}}]
      : bridge?.(args));
    try {
      await send({type:"BOFA_PORTAL_CHECK"});
      await vi.advanceTimersByTimeAsync(25000);
      const state = (await send({type:"BOFA_PORTAL_STATUS"})).state;
      expect(state?.phase).toBe("failed");
      expect(state?.retryAt).toBeUndefined();
      expect(execute.mock.calls.filter(([a])=>a.args[0]==="search")).toHaveLength(6);
    } finally { vi.useRealTimers(); }
  });

  it("does not automatically retry an activation rejected by BofA", async () => {
    const state = await ready();
    const bridge = execute.getMockImplementation();
    execute.mockImplementation(async args => args.args[0] === "activate"
      ? [{ result: { portalId, status: 429, data: null, retryAfterMs: 1000 } }]
      : bridge?.(args));
    await send({ type: "BOFA_PORTAL_ACTIVATE", runId: state.runId, ids: ["2"] });
    await vi.waitFor(async () => expect((await send({ type: "BOFA_PORTAL_STATUS" })).state?.phase).toBe("failed"));
    expect(execute.mock.calls.filter(([args]) => args.args[0] === "activate")).toHaveLength(1);
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


it("persists Done without activation and can reopen the remaining offers", async () => {
  const state = await ready();
  expect(await send({ type: "BOFA_PORTAL_FINISH", runId: "stale" })).toMatchObject({ ok: false });
  expect(await send({ type: "BOFA_PORTAL_FINISH", runId: state.runId })).toMatchObject({ ok: true, state: { reviewFinished: true } });
  expect(await send({ type: "BOFA_PORTAL_STATUS" })).toMatchObject({ state: { reviewFinished: true } });
  expect(await send({ type: "BOFA_PORTAL_REVIEW", runId: state.runId })).toMatchObject({ ok: true, state: { phase: "ready", reviewFinished: false } });
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(execute.mock.calls.some(call => call[0].args[0] === "activate")).toBe(false);
  await send({ type: "BOFA_PORTAL_FINISH", runId: state.runId });
  registerBofaOffers();
  expect(await send({ type: "BOFA_PORTAL_STATUS" })).toMatchObject({ state: { phase: "ready", reviewFinished: true } });
});
it("does not open or read BofA while a different offer engine is running", async () => {
  registerBofaOffers({ isOtherBusy: async () => true });
  expect(await send({ type: "BOFA_PORTAL_CHECK" })).toMatchObject({ ok: false, error: "Finish or stop the current offer check first." });
  expect(execute).not.toHaveBeenCalled();
});

it("can stop the opening check before it starts scanning", async () => {
  let release: ((busy: boolean) => void) | undefined;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const engine = registerBofaOffers({ isOtherBusy: () => gate });
  const opening = send({ type: "BOFA_PORTAL_CHECK" });
  expect(engine.isBusy()).toBe(true);
  await send({ type: "BOFA_PORTAL_CANCEL" });
  release?.(false);
  expect(await opening).toMatchObject({ ok: false, error: "BofA check cancelled." });
  expect(engine.isBusy()).toBe(false);
  expect(execute.mock.calls.some(call => call[0].args?.[0] === "search")).toBe(false);
});
