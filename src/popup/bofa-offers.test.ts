// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { BofaPortalState, PortalOffer } from "../providers/bofa-offers";
import { mountBofaOffers } from "./bofa-offers";

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps sign-in recovery visible across idle status polls", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<section id="bofaOffersCard"></section>';
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
    (b) => b.id === "bofaOffersDiscoverBtn",
  );
  if (!button) throw new Error("Missing BofA check button");
  button.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.body.textContent).toContain("Sign in to continue checking your offers.");
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.body.textContent).toContain("Sign in to continue checking your offers.");
  expect(button.disabled).toBe(false);
});

it("shows an actionable error instead of treating an unrelated OK reply as an empty scan", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<section id="bofaOffersCard"></section>';
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  });
  mountBofaOffers();
  const check = Array.from(document.querySelectorAll("button")).find(
    (b) => b.id === "bofaOffersDiscoverBtn",
  );
  if (!check) throw new Error("Missing check button");
  check.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.body.textContent).toContain("BofA did not return its status");
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.body.textContent).toContain("Reload nextcard sync");
});

it.each([true, false])(
  "confirms only eligible %s bulk or selected activations using the shared review",
  async (all) => {
    vi.useFakeTimers();
    document.body.innerHTML = '<section id="bofaOffersCard"></section>';
    const offer = (id: string, action: PortalOffer["action"]): PortalOffer => ({
      issuerOfferId: id,
      merchantName: `Merchant ${id}`,
      offerValue: "5% cash back",
      detailsText: "Eligible purchases",
      termsText: "Issuer terms",
      category: "general",
      expirationDate: null,
      rewardType: "percentage",
      rewardAmount: 5,
      rewardCurrency: "cash",
      maxReward: null,
      minSpend: null,
      merchantUrl: null,
      merchantLogoUrl: null,
      redemptionChannel: "online",
      action,
      activationExpiresAt: null,
    });
    const state: BofaPortalState = {
      runId: "run",
      phase: "ready",
      total: 6,
      checked: 6,
      discovered: 6,
      added: 0,
      failed: 0,
      error: null,
      saveStatus: "saved",
      offers: [
        offer("1", "activate"),
        offer("2", "activate"),
        offer("3", "ready"),
        offer("4", "activated"),
        offer("5", "shop_through_issuer"),
        offer("6", "merchant_deal"),
      ],
    };
    const send = vi.fn(async (message: Record<string, unknown>) => ({
      ok: true,
      state:
        message.type === "BOFA_PORTAL_ACTIVATE"
          ? { ...state, phase: "activating" }
          : state,
    }));
    vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
    mountBofaOffers();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelectorAll(".offer-review-row")).toHaveLength(2);
    expect(document.body.textContent).toContain("6 offers synced");
    expect(document.body.textContent).not.toContain("Shop through BofA");
    if (!all) {
      const checkbox =
        document.querySelector<HTMLInputElement>('input[value="2"]');
      if (!checkbox) throw new Error("Missing selection");
      checkbox.click();
    }
    const trigger = Array.from(document.querySelectorAll("button")).find(
      (b) =>
        b.textContent ===
        (all ? "Activate all 2 offers" : "Activate 1 selected offer"),
    );
    if (!trigger) throw new Error("Missing activation action");
    trigger.click();
    expect(
      send.mock.calls.some(([m]) => m.type === "BOFA_PORTAL_ACTIVATE"),
    ).toBe(false);
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === (all ? "Activate 2 offers" : "Activate 1 offer"),
    );
    if (!confirm) throw new Error("Missing confirmation");
    confirm.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith({
      type: "BOFA_PORTAL_ACTIVATE",
      runId: "run",
      ids: all ? ["1", "2"] : ["2"],
    });
    expect(document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuemax")).toBe(all?"2":"1");
    if (!all) {
      state.phase = "completed";
      state.added = 1;
      state.offers = state.offers.map(o => o.issuerOfferId === "2" ? { ...o, action: "activated" } : o);
      await vi.advanceTimersByTimeAsync(1500);
      const more = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Add more offers");
      expect(more?.hidden).toBe(false);
      more?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector<HTMLElement>(".offer-review")?.hidden).toBe(false);
      expect(document.querySelectorAll(".offer-review-row")).toHaveLength(1);
      expect(document.body.textContent).toContain("0 of 1 selected");
      const activateRemaining = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Activate all 1 offer");
      activateRemaining?.click();
      const confirmRemaining = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Activate 1 offer");
      confirmRemaining?.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenLastCalledWith({ type: "BOFA_PORTAL_ACTIVATE", runId: "run", ids: ["1"] });
    }
    state.phase = "completed";
    state.offers = state.offers.map(o => o.action === "activate" ? { ...o, action: "activated" } : o);
    await vi.advanceTimersByTimeAsync(1500);
    const finishedMore = Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Add more offers");
    expect(finishedMore?.hidden).toBe(true);

  },
);

it("shows automatic cooldown progress and keeps cancellation available", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<section id="bofaOffersCard"></section>';
  const state: BofaPortalState = {
    runId:"cooldown",phase:"checking",total:100,checked:0,discovered:24,added:0,
    failed:0,offers:[],saveStatus:"saving",error:null,retryAt:Date.now()+45000,
  };
  const send = vi.fn(async () => ({ok:true,state}));
  vi.stubGlobal("chrome",{runtime:{sendMessage:send}});
  mountBofaOffers();
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("Retrying BofA request in 45s…");
  expect(document.querySelector<HTMLButtonElement>("#bofaOffersDiscoverBtn")?.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("42s");
  const cancel = Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Cancel");
  expect(cancel?.hidden).toBe(false);
  cancel?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledWith({type:"BOFA_PORTAL_CANCEL"});
});

it("offers a sign-in recovery action for an expired issuer session", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<section id="bofaOffersCard"></section>';
  const send = vi.fn(async () => ({ ok: true, state: {
    runId: "expired", phase: "failed", total: 0, checked: 0,
    discovered: 0, added: 0, failed: 0, offers: [], saveStatus: "saved",
    error: "Your BofA session expired. Open deals from BofA again.",
  } }));
  vi.stubGlobal("chrome", { runtime: { sendMessage: send } });
  mountBofaOffers();
  await vi.advanceTimersByTimeAsync(0);
  const login = Array.from(document.querySelectorAll("button")).find(
    b => b.textContent === "Sign in to Bank of America",
  );
  expect(login).toBeDefined();
  login?.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledWith({ type: "BOFA_PORTAL_SIGN_IN" });
});
