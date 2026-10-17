// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountDoorDashTest } from "./doordash";
import { normalizeDoorDashReads } from "../providers/doordash";

let sendMessage: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML = '<details id="doorDashTest" open><summary>DoorDash</summary></details>';
  sendMessage = vi.fn(async () => ({ ok: true, snapshot: normalizeDoorDashReads([
    { source: "subscription", status: "ok", data: { plan_id: "plan-a", subscription_status: "ACTIVE" } },
  ], "2026-10-16T12:00:00Z", "account-a") }));
  vi.stubGlobal("chrome", {
    tabs: { query: vi.fn(async () => [{ id: 1, title: "DoorDash account A", active: true }, { id: 2, title: "DoorDash account B" }]), create: vi.fn() },
    runtime: { sendMessage },
  });
});
afterEach(() => vi.unstubAllGlobals());
function button() {
  const value = document.querySelector("#doorDashCheck");
  if (!(value instanceof HTMLButtonElement)) throw new Error("Missing check button");
  return value;
}
it("renders empty campaigns as unobserved and clears results when switching accounts", async () => {
  mountDoorDashTest();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("plan-a"));
  expect(document.body.textContent).toContain("does not confirm they were used");
  expect(document.body.textContent).toContain("Add an item");
  const select = document.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) throw new Error("Missing tab selector");
  select.value = "2";
  select.dispatchEvent(new Event("change"));
  expect(document.body.textContent).not.toContain("plan-a");
  button().click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenLastCalledWith({ type: "DOORDASH_TEST_CHECK", tabId: 2 }));
});
it("removes previous account results when a refresh fails", async () => {
  mountDoorDashTest();
  await vi.waitFor(() => expect(button().disabled).toBe(false));
  button().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("plan-a"));
  sendMessage.mockResolvedValueOnce({ ok: false, error: "Sign in again" });
  button().click();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Sign in again"));
  expect(document.body.textContent).not.toContain("plan-a");
  expect(button().disabled).toBe(false);
});
