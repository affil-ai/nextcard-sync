// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountDoorDashProvider } from "./doordash";
import { normalizeDoorDashReads } from "../providers/doordash";

vi.mock("../lib/auth", () => ({
  getAuth: vi.fn(async () => ({
    token: "test-token",
    name: null,
    email: null,
    signedInAt: "login-a",
  })),
  getAuthGeneration: () => 1,
}));
let localValues: Record<string, unknown>;
let sendMessage: ReturnType<typeof vi.fn>;
let queryTabs: ReturnType<typeof vi.fn>;
let getTab: ReturnType<typeof vi.fn>;
let tabUpdated:
  | ((id: number, change: chrome.tabs.TabChangeInfo) => void)
  | undefined;
beforeEach(() => {
  localValues = {};
  tabUpdated = undefined;
  getTab = vi.fn(async (id: number) => ({ id, status: "complete", url: "https://www.doordash.com/manage-subscription" }));
  document.body.innerHTML =
    '<select id="householdMemberSelect"></select><section id="toolsTabPanel"></section><section id="syncTabPanel"><section id="doorDashProvider"></section></section>';
  sendMessage = vi.fn(async (message: { type: string }) =>
    message.type === "DOORDASH_BENEFITS" ? expectedReply()
      : message.type === "DOORDASH_USAGE_OPTIONS" ? { ok: true, options: [{ cardCreditId: "credit-a", label: "DoorDash grocery", periodStart: "2026-10-01", periodEnd: "2026-12-31", maxUses: 1, amountPerUse: 10, recordedUses: 0, recordedAmount: 0, availability: "unknown" }] }
      : message.type === "DOORDASH_TEST_CARDS"
      ? {
          ok: true,
          cards: [
            {
              userCardId: "card-a",
              name: "My card",
              catalogName: "Chase Freedom",
              lastFourDigits: "1234",
            },
          ],
        }
      : {
          ok: true,
          snapshot: normalizeDoorDashReads(
            [
              {
                source: "subscription",
                status: "ok",
                data: { plan_id: "plan-a", subscription_status: "ACTIVE", is_eligible_for_benefits: true },
              },
              {
                source: "validation:1",
                status: "ok",
                data: {
                  consumer_subscription_plan_benefit_membership_type:
                    "ChaseFreedom",
                },
              },
            ],
            "2026-10-16T12:00:00Z",
            "account-a",
          ),
        },
  );
  queryTabs = vi.fn(async () => [
    { id: 1, title: "DoorDash account A", active: true },
  ]);
  vi.stubGlobal("chrome", {
    tabs: {
      sendMessage: vi.fn(async () => ({ ok: true })),
      query: queryTabs,
      create: vi.fn(async () => ({ id: 3, status: "complete" })),
      update: vi.fn(async (id: number) => ({ id, status: "complete", url: "https://www.doordash.com/manage-subscription" })),
      get: getTab,
      onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
      onUpdated: {
        addListener: vi.fn((listener: typeof tabUpdated) => {
          tabUpdated = listener;
        }),
        removeListener: vi.fn(),
      },
    },
    runtime: { id: "test", sendMessage, onMessage: { addListener: vi.fn(), removeListener: vi.fn() } },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: localValues[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(localValues, values);
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
function button() {
  const value = document.querySelector("#doorDashCheck");
  if (!(value instanceof HTMLButtonElement))
    throw new Error("Missing check button");
  return value;
}
it("renders empty campaigns as unobserved and clears results when switching accounts", async () => {
  queryTabs.mockResolvedValue([
    { id: 1, title: "DoorDash account A", active: true },
    { id: 2, title: "DoorDash account B" },
  ]);
  mountDoorDashProvider();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  expect(sendMessage).toHaveBeenCalledWith({ type: "DOORDASH_TEST_CHECK", tabId: 1 });
  expect(document.getElementById("doorDashTab")?.hidden).toBe(false);
  await vi.waitFor(() => expect(document.body.textContent).toContain("Choose your linked card."));
  expect(document.body.textContent).not.toContain("Technical details");
  expect(document.body.textContent).not.toContain("Copy diagnostics");
  expect(document.body.textContent).not.toContain("plan-a");
  const select = document.querySelector("#doorDashTab");
  if (!(select instanceof HTMLSelectElement))
    throw new Error("Missing tab selector");
  select.value = "2";
  select.dispatchEvent(new Event("change"));
  expect(document.body.textContent).not.toContain("plan-a");
  button().click();
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({
      type: "DOORDASH_TEST_CHECK",
      tabId: 2,
    }),
  );
});
it("removes previous account results when a refresh fails", async () => {
  mountDoorDashProvider();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Choose your linked card."));
  sendMessage.mockResolvedValueOnce({ ok: false, error: "Sign in again" });
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Sign in again"),
  );
  expect(document.body.textContent).not.toContain("plan-a");
  expect(button().disabled).toBe(false);
});
it("requires a card choice and only reports success after the backend acknowledges saving", async () => {
  mountDoorDashProvider();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  const save = document.querySelector("#doorDashSave");
  const cards = document.querySelector("#doorDashCard");
  if (
    !(save instanceof HTMLButtonElement) ||
    !(cards instanceof HTMLSelectElement)
  )
    throw new Error("Missing save controls");
  await vi.waitFor(() => expect(cards.options.length).toBe(2));
  expect(save.disabled).toBe(true);
  cards.value = "card-a";
  cards.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(save.disabled).toBe(false));
  sendMessage.mockResolvedValueOnce({
    ok: true,
    saved: 1,
    snapshot: normalizeDoorDashReads([], "2026-10-16T12:00:00Z", "account-a"),
  });
  save.click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Saved to nextcard"),
  );
  expect(sendMessage).toHaveBeenCalledWith({
    type: "DOORDASH_TEST_SAVE",
    userCardId: "card-a",
  });
});
it("reuses an existing account association on later syncs", async () => {
  const checked = normalizeDoorDashReads(
    [
      {
        source: "validation:1",
        status: "ok",
        data: {
          consumer_subscription_plan_benefit_membership_type: "ChaseFreedom",
        },
      },
    ],
    "2026-10-16T12:00:00Z",
    "account-a",
  );
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_BENEFITS") return expectedReply("likely_used");
    if (message.type === "DOORDASH_TEST_CARDS")
      return {
        ok: true,
        cards: [
          {
            userCardId: "card-a",
            name: "My card",
            catalogName: "Chase Freedom",
            lastFourDigits: "1234",
          },
        ],
        connectedUserCardId: "card-a",
      };
    if (message.type === "DOORDASH_TEST_SAVE")
      return { ok: true, saved: 1, snapshot: checked };
    return { ok: true, snapshot: checked };
  });
  mountDoorDashProvider();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Saved to nextcard"),
  );
  expect(sendMessage).toHaveBeenCalledWith({
    type: "DOORDASH_TEST_SAVE",
    userCardId: "card-a",
  });
});

it("keeps setup collapsed in Rewards and skips the tab picker for a single account", async () => {
  mountDoorDashProvider();
  const panel = document.getElementById("doorDashProvider");
  expect(panel?.parentElement?.id).toBe("syncTabPanel");
  expect(document.getElementById("toolsTabPanel")?.children.length).toBe(0);
  const setup = document.getElementById("doorDashConnection");
  expect(setup?.hidden).toBe(true);
  expect(button().textContent).toBe("Connect");
  button().click();
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({
      type: "DOORDASH_TEST_CHECK",
      tabId: 1,
    }),
  );
  expect(document.getElementById("doorDashTab")?.hidden).toBe(true);
  const technical = document.querySelector(".doordash-technical");
  expect(technical instanceof HTMLDetailsElement && technical.open).toBe(false);
});

it("clears the linked card summary when the household profile changes", async () => {
  const checked = normalizeDoorDashReads(
    [
      {
        source: "validation:1",
        status: "ok",
        data: {
          consumer_subscription_plan_benefit_membership_type: "ChaseFreedom",
        },
      },
    ],
    "2026-10-16T12:00:00Z",
    "account-a",
  );
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_BENEFITS") return expectedReply("likely_used");
    if (message.type === "DOORDASH_TEST_CARDS")
      return {
        ok: true,
        cards: [
          {
            userCardId: "card-a",
            name: "My card",
            catalogName: "Chase Freedom",
            lastFourDigits: null,
          },
        ],
        connectedUserCardId: "card-a",
      };
    if (message.type === "DOORDASH_TEST_SAVE")
      return { ok: true, saved: 1, snapshot: checked };
    return { ok: true, snapshot: checked };
  });
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Saved to nextcard"));
  expect(document.getElementById("doorDashConnection")?.hidden).toBe(false);
  document
    .getElementById("householdMemberSelect")
    ?.dispatchEvent(new Event("change"));
  expect(button().textContent).toBe("Connect");
  expect(
    document.querySelector(".doordash-provider-subtitle")?.textContent,
  ).toBe("Chase credits");
  expect(document.querySelector(".provider-last-sync")?.textContent).toBe("");
});

it("restores the saved provider summary only for the same Nextcard login and profile", async () => {
  const snapshot = normalizeDoorDashReads(
    [
      {
        source: "validation:1",
        status: "ok",
        data: {
          consumer_subscription_plan_benefit_membership_type: "ChaseFreedom",
        },
      },
    ],
    "2026-10-16T12:00:00Z",
    "account-a",
  );
  localValues[`nextcard_doordash_provider_view_v2::${JSON.stringify(["login-a", null, null, null])}`] = {
    scopeKey: JSON.stringify(["login-a", null, null, null]),
    cardLabel: "My connected card",
    snapshot,
  };
  mountDoorDashProvider();
  await vi.waitFor(() => expect(button().textContent).toBe("Refresh"));
  expect(
    document.querySelector(".doordash-provider-subtitle")?.textContent,
  ).toBe("My connected card");
  expect(document.getElementById("doorDashConnection")?.hidden).toBe(true);
  expect(sendMessage).not.toHaveBeenCalled();
});
it("does not restore a different login's saved card", async () => {
  localValues[`nextcard_doordash_provider_view_v2::${JSON.stringify(["login-a", null, null, null])}`] = {
    scopeKey: JSON.stringify(["another-login", null, null, null]),
    cardLabel: "Someone else's card",
    snapshot: normalizeDoorDashReads([], "2026-10-16T12:00:00Z", "account-a"),
  };
  mountDoorDashProvider();
  await vi.waitFor(() =>
    expect(chrome.storage.local.get).toHaveBeenCalledWith(
      `nextcard_doordash_provider_view_v2::${JSON.stringify(["login-a", null, null, null])}`,
    ),
  );
  expect(button().textContent).toBe("Connect");
  expect(document.body.textContent).not.toContain("Someone else's card");
});

it("opens the selected account's DashPass page before reading benefits", async () => {
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({
      type: "DOORDASH_TEST_CHECK",
      tabId: 1,
    }),
  );
  expect(chrome.tabs.update).toHaveBeenCalledWith(1, {
    url: "https://www.doordash.com/manage-subscription",
    active: true,
  });
  expect(document.querySelector('label[for="doorDashCard"]')?.textContent).toBe(
    "nextcard card",
  );
});
it("creates a DashPass tab when DoorDash is not already open", async () => {
  queryTabs.mockResolvedValue([]);
  mountDoorDashProvider();
  const tile = document.querySelector('button[aria-controls="doorDashConnection"]');
  if (!(tile instanceof HTMLButtonElement)) throw new Error("Missing tile");
  tile.click();
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({
      type: "DOORDASH_TEST_CHECK",
      tabId: 3,
    }),
  );
  expect(chrome.tabs.create).toHaveBeenCalledWith({
    url: "https://www.doordash.com/manage-subscription",
    active: true,
  });
  expect(document.body.textContent).not.toContain("Open DoorDash");
  expect(document.body.textContent).not.toContain("Connect again");
});

it("waits for the DashPass page to finish loading before checking the account", async () => {
  getTab.mockResolvedValue({ id: 1, status: "loading", url: "https://www.doordash.com/manage-subscription" });
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() => expect(getTab).toHaveBeenCalledWith(1));
  expect(sendMessage).not.toHaveBeenCalled();
  getTab.mockResolvedValue({ id: 1, status: "complete", url: "https://www.doordash.com/manage-subscription" });
  tabUpdated?.(1, { status: "complete" });
  await vi.waitFor(() =>
    expect(sendMessage).toHaveBeenCalledWith({
      type: "DOORDASH_TEST_CHECK",
      tabId: 1,
    }),
  );
  expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalled();
});

function eligibleSnapshot() {
  const snapshot = normalizeDoorDashReads(
    [],
    "2026-10-18T12:00:00Z",
    "account-a",
  );
  return {
    ...snapshot,
    membership: ["ChaseFreedom"],
    planId: "plan-freedom",
    subscriptionStatus: "ACTIVE",
    eligibleForBenefits: true,
    billingInterval: "month",
    checkoutContextsChecked: 1,
    contexts: [
      {
        source: "placements:checkout:1",
        nonRestaurant: true,
        validationPassed: true,
      },
    ],
    checks: [
      "subscription",
      "membership",
      "carts",
      "placements:wallet",
      "placements:checkout:1",
      "validation:1",
      "account-verification",
    ].map((source) => ({ source, status: "ok" })),
  };
}

it("saves inferred single-use credit usage only after the backend acknowledges it", async () => {
  let recordedUses = 0;
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_BENEFITS") return expectedReply("likely_used");
    if (message.type === "DOORDASH_TEST_CARDS")
      return {
        ok: true,
        cards: [
          {
            userCardId: "card-a",
            name: "Chase Freedom",
            catalogName: "Chase Freedom",
            lastFourDigits: "1234",
          },
        ],
      };
    if (message.type === "DOORDASH_USAGE_OPTIONS")
      return {
        ok: true,
        options: [
          {
            cardCreditId: "credit-a",
            label: "DoorDash grocery",
            periodStart: "2026-10-01",
            periodEnd: "2026-12-31",
            maxUses: 1,
            amountPerUse: 10,
            recordedUses, recordedAmount: recordedUses * 10, availability: "likely_used",
          },
        ],
      };
    if (message.type === "DOORDASH_USAGE_CONFIRM") {
      recordedUses = 1;
      return { ok: true, amountUsed: 10 };
    }
    return { ok: true, snapshot: eligibleSnapshot() };
  });
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("✓ Used"),
  );
  const cards = document.querySelector("#doorDashCard");
  if (!(cards instanceof HTMLSelectElement))
    throw new Error("Missing card picker");
  await vi.waitFor(() => expect(cards.options.length).toBe(2));
  cards.value = "card-a";
  cards.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.querySelector(".doordash-credit-row button")).not.toBeNull());
  const mark = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === "Save usage",
  );
  mark?.click();
  await vi.waitFor(() =>
    expect(document.querySelectorAll('.doordash-credit-use[data-source="recorded"]').length).toBe(1),
  );
  expect(sendMessage).toHaveBeenCalledWith({
    type: "DOORDASH_USAGE_CONFIRM",
    userCardId: "card-a",
    confirmation: {
      cardCreditId: "credit-a",
      periodStart: "2026-10-01",
      periodEnd: "2026-12-31",
      uses: 1,
    },
  });
  expect(chrome.tabs.create).not.toHaveBeenCalled();
});

it("requires a use count for a two-use credit and keeps failed saves retryable", async () => {
  let failSave = true;
  let recordedUses = 0;
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_BENEFITS") return expectedReply("available", 2);
    if (message.type === "DOORDASH_TEST_CARDS")
      return {
        ok: true,
        cards: [
          {
            userCardId: "card-a",
            name: "My card",
            catalogName: "Chase Sapphire Reserve for Business",
            lastFourDigits: null,
          },
        ],
      };
    if (message.type === "DOORDASH_USAGE_OPTIONS")
      return {
        ok: true,
        options: [
          {
            cardCreditId: "credit-a",
            label: "DoorDash grocery",
            periodStart: "2026-10-01",
            periodEnd: "2026-10-31",
            maxUses: 2,
            amountPerUse: 10,
            recordedUses, recordedAmount: recordedUses * 10, availability: "available",
          },
        ],
      };
    if (message.type === "DOORDASH_USAGE_CONFIRM") {
      if (failSave) return { ok: false, error: "Save failed" };
      recordedUses = 2;
      return { ok: true, amountUsed: 20 };
    }
    return { ok: true, snapshot: { ...eligibleSnapshot(), membership: ["ChaseSapphireReserveBiz"] } };
  });
  mountDoorDashProvider();
  button().click();
  const cards = document.querySelector("#doorDashCard");
  if (!(cards instanceof HTMLSelectElement)) throw new Error("Missing cards");
  await vi.waitFor(() => expect(cards.options.length).toBe(2));
  cards.value = "card-a";
  cards.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(document.querySelector(".doordash-credit-row button")).not.toBeNull());
  Array.from(document.querySelectorAll("button"))
    .find((item) => item.textContent === "Mark as used")
    ?.click();
  const count = document.querySelector("#doorDashUsageCount");
  if (!(count instanceof HTMLSelectElement)) throw new Error("Missing count");
  await vi.waitFor(() => expect(count.options.length).toBe(3));
  expect(
    sendMessage.mock.calls.some(
      ([message]) => message.type === "DOORDASH_USAGE_CONFIRM",
    ),
  ).toBe(false);
  count.value = "2";
  count.dispatchEvent(new Event("change"));
  const confirm = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === "Mark as used" && !item.closest("[hidden]"),
  );
  confirm?.click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Save failed"),
  );
  expect(document.querySelectorAll('.doordash-credit-use[data-used="true"]').length).toBe(0);
  failSave = false;
  confirm?.click();
  await vi.waitFor(() =>
    expect(document.querySelectorAll('.doordash-credit-use[data-used="true"]').length).toBe(2),
  );
  expect(sendMessage).toHaveBeenCalledWith({
    type: "DOORDASH_USAGE_CONFIRM",
    userCardId: "card-a",
    confirmation: {
      cardCreditId: "credit-a",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      uses: 2,
    },
  });
});

it("does not infer usage from failed checks or an unvalidated checkout", async () => {
  const snapshot = eligibleSnapshot();
  sendMessage.mockResolvedValueOnce({
    ok: true,
    snapshot: {
      ...snapshot,
      checks: [
        ...snapshot.checks,
        { source: "placements:checkout:2", status: "error", error: "HTTP 403" },
      ],
    },
  });
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Usage unknown"),
  );
  expect(document.body.textContent).not.toContain("appear to have been used");
});

it("blocks a mismatched linked card instead of automatically saving the Freedom account to Reserve", async () => {
  sendMessage.mockImplementation(async (message: { type: string }) =>
    message.type === "DOORDASH_TEST_CARDS"
      ? {
          ok: true,
          cards: [
            {
              userCardId: "card-a",
              name: "Travel card",
              catalogName: "Chase Sapphire Reserve",
              lastFourDigits: "1609",
            },
            {
              userCardId: "card-b",
              name: "Everyday card",
              catalogName: "Chase Freedom",
              lastFourDigits: "1234",
            },
          ],
          connectedUserCardId: "card-a",
        }
      : { ok: true, snapshot: eligibleSnapshot() },
  );
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() =>
    expect(document.querySelectorAll("#doorDashCard option").length).toBe(3),
  );
  expect(
    sendMessage.mock.calls.some(
      ([message]) => message.type === "DOORDASH_TEST_SAVE",
    ),
  ).toBe(false);
  const save = document.querySelector("#doorDashSave");
  const cards = document.querySelector("#doorDashCard");
  if (
    !(save instanceof HTMLButtonElement) ||
    !(cards instanceof HTMLSelectElement)
  )
    throw new Error("Missing card controls");
  expect(Array.from(cards.querySelectorAll("optgroup")).map((group) => group.label)).toEqual(["Matching cards", "Other cards"]);
  expect(cards.options[1]?.value).toBe("card-b");
  expect(cards.options[1]?.textContent).toBe("Chase Freedom (Everyday card) · 1234");
  expect(cards.options[2]?.textContent).toBe("Chase Sapphire Reserve (Travel card) · 1609");
  expect(save.disabled).toBe(true);
  expect(
    Array.from(cards.options).some((option) => option.value === "card-a"),
  ).toBe(true);
  cards.value = "card-a";
  cards.dispatchEvent(new Event("change"));
  expect(save.disabled).toBe(true);
  expect(document.getElementById("doorDashCardMismatch")?.textContent).toContain("Update it in nextcard");
  cards.value = "card-b";
  cards.dispatchEvent(new Event("change"));
  await vi.waitFor(() => expect(save.disabled).toBe(false));
  expect(document.getElementById("doorDashCardMismatch")?.hidden).toBe(true);
});

it("shows cards without an automatic match and offers card management", async () => {
  sendMessage.mockImplementation(async (message: { type: string }) =>
    message.type === "DOORDASH_TEST_CARDS"
      ? {
          ok: true,
          cards: [
            {
              userCardId: "marriott",
              name: "Chase Freedom",
              catalogName: "Marriott Bonvoy Boundless",
              lastFourDigits: "3412",
            },
            {
              userCardId: "reserve",
              name: "Chase Freedom",
              catalogName: "Chase Sapphire Reserve",
              lastFourDigits: "1609",
            },
          ],
        }
      : { ok: true, snapshot: eligibleSnapshot() },
  );
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Choose your linked card."),
  );
  const cards = document.querySelector("#doorDashCard");
  const save = document.querySelector("#doorDashSave");
  if (
    !(cards instanceof HTMLSelectElement) ||
    !(save instanceof HTMLButtonElement)
  )
    throw new Error("Missing controls");
  expect(cards.options.length).toBe(3);
  expect(cards.options[1]?.textContent).toContain("Marriott Bonvoy Boundless");
  cards.value = "reserve";
  cards.dispatchEvent(new Event("change"));
  expect(document.getElementById("doorDashCardMismatch")?.textContent).toContain("Update it in nextcard");
  const manage = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Manage cards");
  manage?.click();
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "https://nextcard.com/dashboard/cards", active: true });
  expect(save.disabled).toBe(true);
  expect(
    sendMessage.mock.calls.some(
      ([message]) => message.type === "DOORDASH_TEST_SAVE",
    ),
  ).toBe(false);
});

it("does not trust display names when the backend has not supplied catalog identity", async () => {
  sendMessage.mockImplementation(async (message: { type: string }) =>
    message.type === "DOORDASH_TEST_CARDS"
      ? {
          ok: true,
          cards: [
            {
              userCardId: "card-a",
              name: "Chase Freedom",
              lastFourDigits: "1609",
            },
          ],
        }
      : { ok: true, snapshot: eligibleSnapshot() },
  );
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      "Choose your linked card.",
    ),
  );
  const save = document.querySelector("#doorDashSave");
  expect(save instanceof HTMLButtonElement && save.disabled).toBe(true);
});


function expectedReply(availability: "available" | "likely_used" | "unknown" = "unknown", maxUses = 1) {
  return { ok: true, benefits: [{ key: "non-restaurant", label: "DoorDash grocery", frequency: maxUses === 2 ? "monthly" : "quarterly", periodStart: "2026-10-01", periodEnd: maxUses === 2 ? "2026-10-31" : "2026-12-31", maxUses, amountPerUse: 10, availability }] };
}

it.each([
  { availability: "available", manualAction: false },
  { availability: "unknown", manualAction: true },
] satisfies { availability: "available" | "unknown"; manualAction: boolean }[])("shows single-use manual entry=$manualAction when availability=$availability", async ({ availability, manualAction }) => {
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_BENEFITS") {
      const reply = expectedReply(availability);
      return { ...reply, benefits: reply.benefits.map((benefit) => ({ ...benefit, cardCreditId: "credit-a", recordedUses: 0 })) };
    }
    if (message.type === "DOORDASH_TEST_CARDS") return { ok: true, cards: [] };
    return { ok: true, snapshot: eligibleSnapshot() };
  });
  mountDoorDashProvider(); button().click();
  await vi.waitFor(() => expect(document.getElementById("doorDashCreditRows")?.textContent).toContain(availability === "available" ? "○ Available" : "○ Usage unknown"));
  const actions = document.getElementById("doorDashCreditRows")?.querySelectorAll("button");
  expect(actions?.length).toBe(manualAction ? 1 : 0);
  if (manualAction) expect(actions?.[0]?.textContent).toBe("Mark as used");
});

it("checks a missing single-use credit before wallet linkage and identifies it as inferred", async () => {
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_BENEFITS") return expectedReply("likely_used");
    if (message.type === "DOORDASH_TEST_CARDS") return { ok: true, cards: [] };
    return { ok: true, snapshot: eligibleSnapshot() };
  });
  mountDoorDashProvider(); button().click();
  await vi.waitFor(() => expect(document.getElementById("doorDashCreditRows")?.textContent).toContain("$10"));
  expect(document.getElementById("doorDashCreditRows")?.textContent).toContain("Q4 2026");
  expect(document.getElementById("doorDashCreditRows")?.textContent).toContain("✓ Used");
  expect(document.querySelectorAll('.doordash-credit-use[data-used="true"]').length).toBe(1);
  expect(document.querySelector('.doordash-credit-use')?.getAttribute("data-source")).toBe("inferred");
  expect(document.querySelector('.doordash-credit-use')?.getAttribute("title")).toContain("not a recorded redemption");
  expect(document.body.textContent).not.toContain("No grocery or retail promo available");
});

it("explains an unavailable credit-details backend while keeping card matching usable", async () => {
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_BENEFITS") return { ok: false, error: "Credit details need the backend update. Your credits have not changed." };
    if (message.type === "DOORDASH_TEST_CARDS") return { ok: true, cards: [{ userCardId: "card-a", name: "Chase Freedom", catalogName: "Chase Freedom", lastFourDigits: "1234" }] };
    return { ok: true, snapshot: eligibleSnapshot() };
  });
  mountDoorDashProvider();
  button().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Choose your linked card."));
  expect(document.getElementById("doorDashCreditRows")?.textContent).toContain("Credit details need the backend update");
  expect(document.body.textContent).not.toContain("Sync again.");
  expect(document.getElementById("doorDashCard")?.textContent).toContain("Chase Freedom");
});


it("starts connecting from one click on the compact benefit tile", async () => {
  mountDoorDashProvider();
  const tile = document.querySelector('button[aria-controls="doorDashConnection"]');
  if (!(tile instanceof HTMLButtonElement)) throw new Error("Missing DoorDash tile");
  expect(tile.textContent).toContain("Chase credits");
  expect(tile.querySelector("button")).toBeNull();
  tile.click();
  expect(document.getElementById("doorDashConnection")?.hidden).toBe(true);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "DOORDASH_TEST_CHECK", tabId: 1 }));
  await vi.waitFor(() => expect(document.getElementById("doorDashConnection")?.hidden).toBe(false));
});

it("restores each household member's own DoorDash connection when switching profiles", async () => {
  const members = [
    { id: "member-a", displayName: "A", isPrimary: true, lifecycleVersion: 1 },
    { id: "member-b", displayName: "B", isPrimary: false, lifecycleVersion: 1 },
  ];
  localValues.nextcard_household_context_v2 = {
    protocolVersion: 2, minimumExtensionVersion: "0.8.9", recommendedExtensionVersion: "0.8.9",
    accountScopeId: "household", contextRevision: "revision", primaryMemberId: "member-a", householdActivated: true,
    capabilities: { householdReads: true, householdWrites: true }, members,
  };
  for (const member of members) {
    const scopeKey = JSON.stringify(["login-a", "household", member.id, 1]);
    localValues[`nextcard_doordash_provider_view_v2::${scopeKey}`] = {
      scopeKey, cardLabel: `${member.displayName}'s card`,
      snapshot: { ...eligibleSnapshot(), accountKey: `doordash-${member.id}` },
    };
  }
  localValues.nextcard_household_selected_member_v2 = "member-a";
  mountDoorDashProvider();
  await vi.waitFor(() => expect(document.querySelector(".doordash-provider-subtitle")?.textContent).toBe("A's card"));
  const changed = vi.mocked(chrome.storage.onChanged.addListener).mock.calls[0]?.[0];
  if (!changed) throw new Error("Missing profile change listener");
  localValues.nextcard_household_selected_member_v2 = "member-b";
  changed({ nextcard_household_selected_member_v2: { newValue: "member-b" } }, "local");
  expect(document.querySelector(".doordash-provider-subtitle")?.textContent).toBe("Chase credits");
  await vi.waitFor(() => expect(document.querySelector(".doordash-provider-subtitle")?.textContent).toBe("B's card"));
  localValues.nextcard_household_selected_member_v2 = "member-a";
  changed({ nextcard_household_selected_member_v2: { newValue: "member-a" } }, "local");
  await vi.waitFor(() => expect(document.querySelector(".doordash-provider-subtitle")?.textContent).toBe("A's card"));
  expect(sendMessage).not.toHaveBeenCalled();
});


it("waits through DoorDash sign-in and resumes without a second Connect click", async () => {
  let signedIn = false;
  getTab.mockImplementation(async (id: number) => ({ id, status: "complete", url: signedIn ? "https://www.doordash.com/manage-subscription" : "https://identity.doordash.com/auth" }));
  mountDoorDashProvider();
  const tile = document.querySelector('button[aria-controls="doorDashConnection"]');
  if (!(tile instanceof HTMLButtonElement)) throw new Error("Missing tile");
  tile.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Sync will continue automatically"));
  expect(sendMessage).not.toHaveBeenCalled();
  expect(document.getElementById("doorDashConnection")?.hidden).toBe(true);
  expect(document.querySelector(".provider-last-sync")?.textContent).toBe("Waiting for sign-in…");
  expect(document.querySelector(".provider-last-sync")?.closest("#doorDashConnection")).toBeNull();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: "DOORDASH_PAGE_OVERLAY", state: "waiting" });
  signedIn = true;
  tabUpdated?.(1, { status: "complete" });
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "DOORDASH_TEST_CHECK", tabId: 1 }));
  await vi.waitFor(() => expect(document.body.textContent).toContain("Choose your linked card."));
  expect(chrome.tabs.onRemoved.removeListener).toHaveBeenCalled();
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: "DOORDASH_PAGE_OVERLAY", state: "clear" });
});


it.each([
  { availability: "available", recordedUses: 0, message: "At least 1 of 2 available.", used: 0 },
  { availability: "available", recordedUses: 1, message: "At least 1 of 2 available.", used: 1 },
  { availability: "available", recordedUses: 2, message: "All 2 credits marked as used.", used: 2 },
  { availability: "likely_used", recordedUses: 0, message: "All credits may have been used.", used: 0 },
  { availability: "unknown", recordedUses: 0, message: "Availability could not be confirmed.", used: 0 },
] satisfies { availability: "available" | "likely_used" | "unknown"; recordedUses: number; message: string; used: number }[])("groups the two credits with $recordedUses recorded and availability=$availability", async ({ availability, recordedUses, message, used }) => {
  sendMessage.mockImplementation(async (request: { type: string }) => {
    if (request.type === "DOORDASH_BENEFITS") {
      const reply = expectedReply(availability, 2);
      return { ...reply, benefits: reply.benefits.map((benefit) => ({ ...benefit, cardCreditId: "credit-a", recordedUses })) };
    }
    if (request.type === "DOORDASH_TEST_CARDS") return { ok: true, cards: [] };
    return { ok: true, snapshot: eligibleSnapshot() };
  });
  mountDoorDashProvider(); button().click();
  await vi.waitFor(() => expect(document.getElementById("doorDashCreditRows")?.textContent).toContain(message));
  const rows = document.getElementById("doorDashCreditRows");
  expect(rows?.textContent).toContain("2 × $10 credits");
  expect(rows?.textContent).not.toContain("Usage unknown");
  expect(rows?.querySelectorAll('.doordash-credit-use[data-used="true"]').length).toBe(used);
  expect(rows?.querySelectorAll('.doordash-credit-use[data-used="false"]').length).toBe(0);
  if (recordedUses === 2) expect(rows?.textContent).not.toContain("At least 1");
  expect(rows?.querySelectorAll("button").length).toBe(recordedUses < 2 ? 1 : 0);
});


it("anchors results after user-initiated checks and saves", async () => {
  const scrollIntoView = vi.fn();
  mountDoorDashProvider();
  const panel = document.getElementById("doorDashProvider");
  if (!panel) throw new Error("Missing DoorDash provider");
  panel.scrollIntoView = scrollIntoView;
  expect(scrollIntoView).not.toHaveBeenCalled();
  button().click();
  await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" }));
  expect(document.getElementById("doorDashConnection")?.hidden).toBe(false);
  const cards = document.getElementById("doorDashCard");
  if (!(cards instanceof HTMLSelectElement)) throw new Error("Missing card picker");
  cards.value = "card-a";
  cards.dispatchEvent(new Event("change"));
  const save = document.getElementById("doorDashSave");
  if (!(save instanceof HTMLButtonElement)) throw new Error("Missing save button");
  await vi.waitFor(() => expect(save.disabled).toBe(false));
  scrollIntoView.mockClear();
  sendMessage.mockResolvedValueOnce({ ok: true, saved: 1, snapshot: eligibleSnapshot() });
  save.click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Saved to nextcard"));
  await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  expect(document.getElementById("doorDashConnection")?.hidden).toBe(false);
  expect(document.getElementById("doorDashCreditRows")?.textContent).not.toBe("Loading credits…");
});
