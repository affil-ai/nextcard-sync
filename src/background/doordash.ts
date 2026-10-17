import { doorDashQueries, doorDashReadSchema, normalizeDoorDashReads } from "../providers/doordash";

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
  const csrf = document.cookie.split("; ").find((cookie) => cookie.startsWith("csrftoken="))?.split("=").slice(1).join("=");
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "x-experience-id": "doordash",
    "x-channel-id": "marketplace",
    ...(csrf ? { "x-csrftoken": decodeURIComponent(csrf) } : {}),
  };
  async function read(source: string, path: string, payload?: { query: string; operationName: string; variables: Record<string, unknown> }) {
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
      if (!response.ok) return { source, status: "error", error: `HTTP ${response.status}. Sign in to DoorDash or finish its browser verification, then retry.` };
      const json: unknown = await response.json();
      if (record(json).errors) return { source, status: "error", error: "DoorDash could not complete this query. No usage was inferred." };
      return { source, status: "ok", data: payload ? record(json).data : json };
    } catch {
      return { source, status: "error", error: "DoorDash did not return a readable response before the timeout. Retry after the page loads." };
    } finally {
      clearTimeout(timeout);
    }
  }
  function gql(source: string, operationName: string, query: string, variables: Record<string, unknown> = {}) {
    return read(source, `/graphql/${operationName}`, { query, operationName, variables });
  }
  const reads = await Promise.all([
    read("subscription", "/unified-gateway/cx/subscriptions/v1/get_active_subscription_status?subscription_type=DASHPASS"),
    gql("membership", "subscriptionInformation", queries.membership),
    gql("carts", "listCarts", queries.carts, { input: { cartFilter: { shouldIncludeSubmitted: false } } }),
    gql("placements:wallet", "getPlacements", queries.placements, { location: "HOMEPAGE", component: "WALLET" }),
  ]);
  const cartData = record(reads.find((item) => item.source === "carts" && item.status === "ok")?.data).listCarts;
  const carts: unknown[] = Array.isArray(cartData) ? cartData.slice(0, 3) : [];
  for (const [index, value] of carts.entries()) {
    const cart = record(value);
    const storeId = text(record(cart.restaurant).id);
    if (!storeId || typeof cart.subtotal !== "number") continue;
    const consumerId = text(record(cart.creator).id);
    reads.push(...await Promise.all([
      gql(`placements:checkout:${index + 1}`, "getPlacements", queries.placements, {
        location: "CHECKOUT", component: "BANNER", storeId,
        subtotal: { unitAmount: cart.subtotal, currency: "USD", decimalPlaces: 2, displayString: `$${(cart.subtotal / 100).toFixed(2)}` },
      }),
      ...(consumerId ? [read(`validation:${index + 1}`, `/unified-gateway/cx/subscriptions/v1/partner_plan_benefit_validation?${new URLSearchParams({ is_card_payment: "true", order_cart_id: text(cart.id), consumer_id: consumerId, store_id: storeId })}`)] : []),
    ]));
  }
  // The export uses a fingerprint instead of the subscription identifier.
  const subscription = record(reads.find((item) => item.source === "subscription" && item.status === "ok")?.data);
  const subscriptionId = text(subscription.consumer_subscription_id);
  if (subscriptionId) {
    const verification = await read("account-verification", "/unified-gateway/cx/subscriptions/v1/get_active_subscription_status?subscription_type=DASHPASS");
    if (verification.status !== "ok" || text(record(verification.data).consumer_subscription_id) !== subscriptionId) {
      throw new Error("The DoorDash account changed or its session expired during the check. Check again.");
    }
    reads.push(verification);
  }
  const digest = subscriptionId ? await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`doordash:${subscriptionId}`)) : null;
  const accountKey = digest ? Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16) : null;
  return { reads, accountKey };
}

export async function checkDoorDashTab(tabId: number) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || new URL(tab.url).origin !== "https://www.doordash.com") throw new Error("Select a signed-in www.doordash.com tab.");
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN", func: readDoorDashSession, args: [doorDashQueries],
  });
  const raw: unknown = results[0]?.result;
  if (typeof raw !== "object" || raw === null || !("reads" in raw)) throw new Error("DoorDash did not return a result. Reload its tab and retry.");
  const reads = doorDashReadSchema.array().parse(raw.reads);
  const accountKey = "accountKey" in raw && typeof raw.accountKey === "string" ? raw.accountKey : null;
  const snapshot = normalizeDoorDashReads(reads, new Date().toISOString(), accountKey);
  const currentTab = await chrome.tabs.get(tabId);
  if (!currentTab.url || new URL(currentTab.url).origin !== "https://www.doordash.com") throw new Error("The selected tab left DoorDash during the check. Select a DoorDash tab and retry.");
  if (!snapshot.planId && !snapshot.subscriptionStatus && !snapshot.membership.length) {
    throw new Error("Could not read your membership. Sign in to DoorDash, finish any browser verification, then retry.");
  }
  return snapshot;
}

export function registerDoorDashTest() {
  let busy = false;
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "DOORDASH_TEST_CHECK") return false;
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("src/popup/popup.html")) return false;
    if (!("tabId" in message) || typeof message.tabId !== "number" || !Number.isInteger(message.tabId)) {
      respond({ ok: false, error: "Select a DoorDash tab first." });
      return false;
    }
    if (busy) {
      respond({ ok: false, error: "A DoorDash check is already running. Wait for it to finish." });
      return false;
    }
    busy = true;
    void checkDoorDashTab(message.tabId).then(
      (snapshot) => respond({ ok: true, snapshot }),
      (error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : "DoorDash check failed." }),
    ).finally(() => { busy = false; });
    return true;
  });
}
