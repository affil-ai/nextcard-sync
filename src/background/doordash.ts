import { doorDashUsageConfirmationSchema } from "../providers/doordash";
import {
  doorDashQueries,
  doorDashReadSchema,
  normalizeDoorDashReads,
} from "../providers/doordash";
import { z } from "zod";
import { getAuth, getAuthGeneration } from "../lib/auth";
import {
  getCurrentHouseholdOperationScope,
  householdOperationScopesMatch,
  isLegacyHouseholdOperationMode,
  type HouseholdOperationScope,
} from "../lib/household-context";

// Chrome serializes this function into the selected DoorDash tab. Keep all
// runtime helpers inside it and pass query strings as serializable arguments.
export async function readDoorDashSession(queries: typeof doorDashQueries) {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
  }
  function text(value: unknown) {
    return typeof value === "string" ? value : "";
  }
  const csrf = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith("csrftoken="))
    ?.split("=")
    .slice(1)
    .join("=");
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-experience-id": "doordash",
    "x-channel-id": "marketplace",
    ...(csrf ? { "x-csrftoken": decodeURIComponent(csrf) } : {}),
  };
  async function read(
    source: string,
    path: string,
    payload?: {
      query: string;
      operationName: string;
      variables: Record<string, unknown>;
    },
    discoverStores = false,
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(path, {
        method: payload ? "POST" : "GET",
        credentials: "include",
        cache: "no-store",
        headers,
        signal: controller.signal,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (!response.ok)
        return {
          source,
          status: "error",
          error: `HTTP ${response.status}. Sign in to DoorDash or finish its browser verification, then retry.`,
        };
      if (discoverStores) {
        const html = await response.text();
        const storeIds = new Map<string, boolean>();
        for (const match of html.matchAll(/href=["']([^"']+)["']/g)) {
          const href = match[1];
          if (!href) continue;
          const url = new URL(href, "https://www.doordash.com");
          if (url.origin !== "https://www.doordash.com") continue;
          const store = url.pathname.match(/^\/(?:convenience\/)?store\/(?:[^/]*-)?(\d+)\/?$/);
          if (store?.[1]) storeIds.set(store[1], storeIds.get(store[1]) === true || url.pathname.startsWith("/convenience/"));
        }
        return { source, status: "ok", data: { storeIds: [...storeIds].sort((left, right) => Number(right[1]) - Number(left[1])).slice(0, 3).map(([id]) => id) } };
      }
      const json: unknown = await response.json();
      if (record(json).errors)
        return {
          source,
          status: "error",
          error:
            "DoorDash could not complete this query. No usage was inferred.",
        };
      return { source, status: "ok", data: payload ? record(json).data : json };
    } catch {
      return {
        source,
        status: "error",
        error:
          "DoorDash did not return a readable response before the timeout. Retry after the page loads.",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  function gql(
    source: string,
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
  ) {
    return read(source, `/graphql/${operationName}`, {
      query,
      operationName,
      variables,
    });
  }
  const reads = await Promise.all([
    read(
      "subscription",
      "/unified-gateway/cx/subscriptions/v1/get_active_subscription_status?subscription_type=DASHPASS",
    ),
    gql("membership", "subscriptionInformation", queries.membership),
    gql("carts", "listCarts", queries.carts, {
      input: { cartFilter: { shouldIncludeSubmitted: false } },
    }),
    gql("placements:wallet", "getPlacements", queries.placements, {
      location: "HOMEPAGE",
      component: "WALLET",
    }),
  ]);
  const cartData = record(
    reads.find((item) => item.source === "carts" && item.status === "ok")?.data,
  ).listCarts;
  const carts: unknown[] = Array.isArray(cartData)
    ? [...cartData].sort((left, right) =>
        Number(record(right).isConvenienceCart === true) -
        Number(record(left).isConvenienceCart === true),
      ).slice(0, 3)
    : [];
  for (const [index, value] of carts.entries()) {
    const cart = record(value);
    const storeId = text(record(cart.restaurant).id);
    if (!storeId || typeof cart.subtotal !== "number") continue;
    const consumerId = text(record(cart.creator).id);
    reads.push({
      source: `context:${index + 1}`,
      status: "ok",
      data: { nonRestaurant: cart.isConvenienceCart === true },
    });
    reads.push(
      ...(await Promise.all([
        gql(
          `placements:checkout:${index + 1}`,
          "getPlacements",
          queries.placements,
          {
            location: "CHECKOUT",
            component: "BANNER",
            storeId,
            subtotal: {
              unitAmount: cart.subtotal,
              currency: "USD",
              decimalPlaces: 2,
              displayString: `$${(cart.subtotal / 100).toFixed(2)}`,
            },
          },
        ),
        ...(consumerId
          ? [
              read(
                `validation:${index + 1}`,
                `/unified-gateway/cx/subscriptions/v1/partner_plan_benefit_validation?${new URLSearchParams({ is_card_payment: "true", order_cart_id: text(cart.id), consumer_id: consumerId, store_id: storeId })}`,
              ),
            ]
          : []),
      ])),
    );
  }
  // Store placements can expose account campaigns without creating a cart.
  // Their absence is not checkout validation and must never imply usage.
  if (!reads.some((item) => item.source.startsWith("context:"))) {
    const stores = await read("stores", "/home", undefined, true);
    reads.push(stores);
    const storeIds = record(stores.data).storeIds;
    if (Array.isArray(storeIds)) {
      for (const [index, storeId] of storeIds.entries()) {
        if (typeof storeId !== "string") continue;
        reads.push(await gql(`placements:store:${index + 1}`, "getPlacements", queries.placements, {
          location: "STORE", component: "CAROUSEL", storeId,
        }));
      }
    }
  }
  // The export uses a fingerprint instead of the subscription identifier.
  const subscription = record(
    reads.find((item) => item.source === "subscription" && item.status === "ok")
      ?.data,
  );
  const subscriptionId = text(subscription.consumer_subscription_id);
  if (subscriptionId) {
    const verification = await read(
      "account-verification",
      "/unified-gateway/cx/subscriptions/v1/get_active_subscription_status?subscription_type=DASHPASS",
    );
    if (
      verification.status !== "ok" ||
      text(record(verification.data).consumer_subscription_id) !==
        subscriptionId
    ) {
      throw new Error(
        "The DoorDash account changed or its session expired during the check. Check again.",
      );
    }
    reads.push(verification);
  }
  const digest = subscriptionId
    ? await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`doordash:${subscriptionId}`),
      )
    : null;
  const accountKey = digest
    ? Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      )
        .join("")
        .slice(0, 16)
    : null;
  return { reads, accountKey };
}

export async function checkDoorDashTab(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || new URL(tab.url).origin !== "https://www.doordash.com")
    throw new Error("Select a signed-in www.doordash.com tab.");
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: readDoorDashSession,
    args: [doorDashQueries],
  });
  const raw: unknown = results[0]?.result;
  if (typeof raw !== "object" || raw === null || !("reads" in raw))
    throw new Error(
      "DoorDash did not return a result. Reload its tab and retry.",
    );
  const reads = doorDashReadSchema.array().parse(raw.reads);
  const accountKey =
    "accountKey" in raw && typeof raw.accountKey === "string"
      ? raw.accountKey
      : null;
  const snapshot = normalizeDoorDashReads(
    reads,
    new Date().toISOString(),
    accountKey,
  );
  const currentTab = await chrome.tabs.get(tabId);
  if (
    !currentTab.url ||
    new URL(currentTab.url).origin !== "https://www.doordash.com"
  )
    throw new Error(
      "The selected tab left DoorDash during the check. Select a DoorDash tab and retry.",
    );
  if (
    !snapshot.planId &&
    !snapshot.subscriptionStatus &&
    !snapshot.membership.length
  ) {
    throw new Error(
      "Could not read your membership. Sign in to DoorDash, finish any browser verification, then retry.",
    );
  }
  return snapshot;
}

export function registerDoorDashTest() {
  let busy = false;
  let operation: {
    snapshot: Awaited<ReturnType<typeof checkDoorDashTab>>;
    tabId: number;
    generation: number;
    token: string;
    scope: HouseholdOperationScope | null;
  } | null = null;
  async function requireCurrent(op: NonNullable<typeof operation>) {
    const auth = await getAuth();
    const scope = await getCurrentHouseholdOperationScope();
    if (
      !auth ||
      auth.token !== op.token ||
      op.generation !== getAuthGeneration() ||
      (op.scope
        ? scope === null || !householdOperationScopesMatch(op.scope, scope)
        : scope !== null || !(await isLegacyHouseholdOperationMode()))
    ) {
      throw new Error(
        "The nextcard account or selected household profile changed. Check DoorDash again.",
      );
    }
  }
  async function request(
    op: NonNullable<typeof operation>,
    body: Record<string, unknown>,
  ) {
    await requireCurrent(op);
    const endpoint = body.operation === "benefits" || body.operation === "usage-options" || body.operation === "confirm-usage" ? "benefit-usage" : "benefit-sync";
    const response = await fetch(
      `${__CONVEX_SITE_URL__}/extension/${op.scope ? "v2/" : ""}${endpoint}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${op.token}`,
          ...(op.scope
            ? {
                "X-Nextcard-Protocol-Version": "2",
                "X-Nextcard-Extension-Version":
                  chrome.runtime.getManifest().version,
              }
            : {}),
        },
        body: JSON.stringify({
          ...body,
          ...(op.scope
            ? {
                memberId: op.scope.memberId,
                memberLifecycleVersion: op.scope.memberLifecycleVersion,
                contextRevision: op.scope.contextRevision,
              }
            : {}),
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    await requireCurrent(op);
    if (endpoint === "benefit-usage" && response.status === 404)
      throw new Error("Usage confirmation needs the backend update. Usage unchanged.");
    const result: unknown = await response.json();
    if (!response.ok) {
      const parsed = z
        .object({ code: z.string().optional() })
        .safeParse(result);
      if (body.operation === "benefits" && response.status === 400 && parsed.success && parsed.data.code === "invalid_request")
        throw new Error("Credit details need the backend update. Your credits have not changed.");
      throw new Error(
        `nextcard could not save this sync (${parsed.success ? (parsed.data.code ?? response.status) : response.status}). Check the account, selected card, and backend deployment, then retry.`,
      );
    }
    return result;
  }
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      ![
        "DOORDASH_TEST_CHECK",
        "DOORDASH_TEST_CARDS",
        "DOORDASH_TEST_SAVE",
        "DOORDASH_BENEFITS",
        "DOORDASH_USAGE_OPTIONS",
        "DOORDASH_USAGE_CONFIRM",
      ].includes(String(message.type))
    )
      return false;
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("src/popup/popup.html")
    )
      return false;
    if (
      message.type === "DOORDASH_TEST_CHECK" &&
      (!("tabId" in message) ||
        typeof message.tabId !== "number" ||
        !Number.isInteger(message.tabId))
    ) {
      respond({ ok: false, error: "Select a DoorDash tab first." });
      return false;
    }
    if (busy) {
      respond({
        ok: false,
        error: "A DoorDash check is already running. Wait for it to finish.",
      });
      return false;
    }
    busy = true;
    void (async () => {
      if (
        message.type === "DOORDASH_TEST_CHECK" &&
        "tabId" in message &&
        typeof message.tabId === "number"
      ) {
        operation = null;
        const auth = await getAuth();
        if (!auth)
          throw new Error("Sign in to nextcard before syncing DoorDash.");
        const generation = getAuthGeneration();
        const scope = await getCurrentHouseholdOperationScope();
        const snapshot = await checkDoorDashTab(message.tabId);
        const op = {
          snapshot,
          tabId: message.tabId,
          generation,
          token: auth.token,
          scope,
        };
        await requireCurrent(op);
        operation = op;
        return { ok: true, snapshot };
      }
      const op = operation;
      if (!op) throw new Error("Check DoorDash again before saving.");
      await requireCurrent(op);
      if (message.type === "DOORDASH_TEST_CARDS")
        return request(op, { accountKey: op.snapshot.accountKey });
      if (message.type === "DOORDASH_BENEFITS")
        return request(op, { operation: "benefits", snapshot: op.snapshot });
      if (!("userCardId" in message) || typeof message.userCardId !== "string")
        throw new Error("Choose a nextcard card first.");
      const fresh = await checkDoorDashTab(op.tabId);
      if (
        !fresh.accountKey ||
        fresh.accountKey !== op.snapshot.accountKey ||
        fresh.planId !== op.snapshot.planId
      )
        throw new Error(
          "The DoorDash account or plan changed. Check again and choose its card.",
        );
      if (
        message.type === "DOORDASH_USAGE_OPTIONS" ||
        message.type === "DOORDASH_USAGE_CONFIRM"
      ) {
        const confirmation =
          message.type === "DOORDASH_USAGE_CONFIRM"
            ? doorDashUsageConfirmationSchema.parse(
                "confirmation" in message ? message.confirmation : undefined,
              )
            : undefined;
        const result = await request(op, {
          operation:
            message.type === "DOORDASH_USAGE_OPTIONS"
              ? "usage-options"
              : "confirm-usage",
          userCardId: message.userCardId,
          snapshot: fresh,
          ...(confirmation ? { confirmation } : {}),
        });
        operation = { ...op, snapshot: fresh };
        return result;
      }
      const result = await request(op, {
        userCardId: message.userCardId,
        snapshot: fresh,
      });
      operation = { ...op, snapshot: fresh };
      return {
        ...z.object({ ok: z.literal(true), saved: z.number() }).parse(result),
        snapshot: fresh,
      };
    })().then(
      (result) => {
        busy = false;
        respond(result);
      },
      (error: unknown) => {
        busy = false;
        respond({
          ok: false,
          error:
            error instanceof Error ? error.message : "DoorDash sync failed.",
        });
      },
    );
    return true;
  });
}
