// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountBofaOffers } from "./bofa-offers";

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps the portal-opening instruction visible across idle status polls", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<section id="bofaOffersPanel"></section>';
  const instruction =
    "In BofA, open Rewards & Deals, then Cash back deals. Keep that deals portal open and check offers again.";
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message: { type: string }) =>
        message.type === "BOFA_PORTAL_CHECK"
          ? { ok: false, error: instruction }
          : { ok: true, state: null },
      ),
    },
  });
  mountBofaOffers();
  await vi.advanceTimersByTimeAsync(0);
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Check BofA offers",
  );
  if (!button) throw new Error("Missing BofA check button");
  button.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.body.textContent).toContain(instruction);
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.body.textContent).toContain(instruction);
  expect(button.disabled).toBe(false);
});

it("shows an actionable error instead of treating an unrelated OK reply as an empty scan", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<section id="bofaOffersPanel"></section>';
  vi.stubGlobal("chrome", {runtime:{sendMessage:vi.fn(async()=>({ok:true}))}});
  mountBofaOffers();
  const check=Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Check BofA offers");
  if (!check) throw new Error("Missing check button");
  check.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.body.textContent).toContain("BofA did not return its status");
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.body.textContent).toContain("Reload nextcard sync");
});
