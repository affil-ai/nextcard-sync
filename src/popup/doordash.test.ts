// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountDoorDashTest } from "./doordash";
import { normalizeDoorDashReads } from "../providers/doordash";

let sendMessage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML =
    '<details id="doorDashTest" open><summary>DoorDash</summary></details>';
  sendMessage = vi.fn(async (message: { type: string }) =>
    message.type === "DOORDASH_TEST_CARDS"
      ? {
          ok: true,
          cards: [
            { userCardId: "card-a", name: "My card", lastFourDigits: "1234" },
          ],
        }
      : {
          ok: true,
          snapshot: normalizeDoorDashReads(
            [
              {
                source: "subscription",
                status: "ok",
                data: { plan_id: "plan-a", subscription_status: "ACTIVE" },
              },
            ],
            "2026-10-16T12:00:00Z",
            "account-a",
          ),
        },
  );
  vi.stubGlobal("chrome", {
    tabs: {
      query: vi.fn(async () => [
        { id: 1, title: "DoorDash account A", active: true },
        { id: 2, title: "DoorDash account B" },
      ]),
      create: vi.fn(),
    },
    runtime: { sendMessage },
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
  mountDoorDashTest();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("plan-a"));
  expect(document.body.textContent).toContain(
    "does not confirm they were used",
  );
  expect(document.body.textContent).toContain("Add an item");
  const select = document.querySelector("select");
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
  mountDoorDashTest();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("plan-a"));
  sendMessage.mockResolvedValueOnce({ ok: false, error: "Sign in again" });
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Sign in again"),
  );
  expect(document.body.textContent).not.toContain("plan-a");
  expect(button().disabled).toBe(false);
});
it("requires a card choice and only reports success after the backend acknowledges saving", async () => {
  mountDoorDashTest();
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
  expect(save.disabled).toBe(false);
  sendMessage.mockResolvedValueOnce({
    ok: true,
    saved: 1,
    snapshot: normalizeDoorDashReads([], "2026-10-16T12:00:00Z", "account-a"),
  });
  save.click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Saved 1 benefit observations"),
  );
  expect(sendMessage).toHaveBeenCalledWith({
    type: "DOORDASH_TEST_SAVE",
    userCardId: "card-a",
  });
});
it("reuses an existing account association on later syncs", async () => {
  const checked = normalizeDoorDashReads(
    [],
    "2026-10-16T12:00:00Z",
    "account-a",
  );
  sendMessage.mockImplementation(async (message: { type: string }) => {
    if (message.type === "DOORDASH_TEST_CARDS")
      return {
        ok: true,
        cards: [
          { userCardId: "card-a", name: "My card", lastFourDigits: "1234" },
        ],
        connectedUserCardId: "card-a",
      };
    if (message.type === "DOORDASH_TEST_SAVE")
      return { ok: true, saved: 1, snapshot: checked };
    return { ok: true, snapshot: checked };
  });
  mountDoorDashTest();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Saved 1 benefit observations"),
  );
  expect(sendMessage).toHaveBeenCalledWith({
    type: "DOORDASH_TEST_SAVE",
    userCardId: "card-a",
  });
});
