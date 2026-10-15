// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createOfferOperation, type OfferOperationSnapshot, type OfferOperationCard, type OfferOperationState } from "../lib/offer-operation";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("keeps card-specific choices through confirmation and releases review with Done", async () => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/src/popup/popup.html`, "utf8");
  const cards: OfferOperationCard[] = ["one", "two"].map((key, index) => ({ key, name: `Card ${index + 1}`, lastDigits: index === 0 ? "1234" : "5678",
    availableCount: 1, countStatus: "complete",
    offers: [{ id: `${key}-offer`, name: `Merchant ${index + 1}`, value: "10% back", details: "Eligible purchases", terms: "Up to $10" }],
  }));
  const ready: OfferOperationState = { ...createOfferOperation("chase", "run"), phase: "ready_to_add",
    checkedAt: new Date().toISOString(), ownedTabId: 42, cards };
  let snapshot: OfferOperationSnapshot = { active: ready, history: { chase: ready } };
  const usage = { accountLevel: "pro", used: 0, remaining: null, limit: null };
  let finishUsage: ((value: typeof usage) => void) | undefined;
  const usageReady = new Promise<typeof usage>((resolve) => { finishUsage = resolve; });
  let profileReady = false;
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    switch (message.type) {
      case "GET_AUTH_STATE": return { token: "test-token", email: "test@example.com", signedInAt: "test" };
      case "GET_EXTENSION_PROFILE": return profileReady ? { accountLevel: "pro", offersFirstUiEnabled: true } : null;
      case "GET_OFFER_ACTIVATION_USAGE": return usageReady;
      case "GET_OFFER_OPERATION_STATUS": return snapshot;
      case "START_OFFER_ENROLLMENT": return { ok: true };
      case "FINISH_OFFER_REVIEW": snapshot = { ...snapshot, active: null }; return { ok: true };
      default: return null;
    }
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage, onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.8.5" }), getURL: (path: string) => path },
    storage: { local: { get: async () => ({ disclosureAccepted: false, consentGiven: true, firstSyncCompleted: true,
      offersIntroVersion: 0, offerConsentVersion: 100 }), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} } },
    tabs: { create: vi.fn() }, windows: { getCurrent: async () => ({ id: 1 }) } });
  await import("./app");
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "GET_EXTENSION_PROFILE" }));
  expect(document.getElementById("loadingView")?.classList.contains("active")).toBe(true);
  expect(document.getElementById("disclosureView")?.classList.contains("active")).toBe(false);
  profileReady = true;
  await vi.waitFor(() => expect(document.querySelectorAll("#chaseOffersReview input")).toHaveLength(1));
  expect(document.getElementById("homeView")?.classList.contains("active")).toBe(true);
  expect(document.getElementById("disclosureView")?.classList.contains("active")).toBe(false);
  const run = document.getElementById("chaseOffersRunBtn");
  if (!(run instanceof HTMLButtonElement)) throw new Error("Missing activation button");
  expect(run.disabled).toBe(true);
  expect(run.textContent).toBe("Loading activation allowance…");
  expect(document.getElementById("chaseOffersQuotaNotice")).toBeNull();
  finishUsage?.(usage);
  await vi.waitFor(() => expect(run.textContent).toBe("Choose offers to activate"));
  const first = document.querySelector("#chaseOffersReview input");
  if (!(first instanceof HTMLInputElement)) throw new Error("Missing offer choice"); first.click();
  expect(run.textContent).toContain("1234"); expect(run.disabled).toBe(false);
  run.click();
  expect(document.getElementById("offerConfirmBody")?.textContent).toContain("1234");
  const secondCard = document.querySelectorAll("#chaseOfferCardChoices button")[1];
  if (!(secondCard instanceof HTMLButtonElement)) throw new Error("Missing second card");
  secondCard.click();
  document.getElementById("offerConfirmContinue")?.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "START_OFFER_ENROLLMENT",
    runId: "run", selectedCardKeys: ["one"], selectedOfferIdsByCard: { one: ["one-offer"] }, total: 1 })));
  const done = document.querySelector('[data-finish-offers="chase"]');
  if (!(done instanceof HTMLButtonElement)) throw new Error("Missing Done button"); done.click();
  await vi.waitFor(() => expect(document.getElementById("chaseOffersSummary")?.textContent).toContain("No offers activated"));
  const otherIssuer = document.getElementById("amexOffersDiscoverBtn");
  if (!(otherIssuer instanceof HTMLButtonElement)) throw new Error("Missing issuer button");
  expect(otherIssuer.disabled).toBe(false);
});

it("lets the install guide own sign-in and restores sidebar sign-in when the guide closes", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/src/popup/popup.html`, "utf8");
  let guideOpen = true;
  const query = vi.fn(async () => guideOpen ? [{ id: 42 }] : []);
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn(async (message: Record<string, unknown>) => {
        if (message.type === "GET_EXTENSION_PROFILE") return { accountLevel: "free", offersFirstUiEnabled: true };
        return null;
      }),
      onMessage: { addListener: () => {} },
      getManifest: () => ({ version: "0.8.5" }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    tabs: { query, create: vi.fn() },
    windows: { getCurrent: async () => ({ id: 1 }) },
  });
  await import("./app");
  await vi.waitFor(() => expect(document.getElementById("authView")?.classList.contains("active")).toBe(true), { timeout: 3000 });
  expect(document.getElementById("authView")?.classList.contains("guided-setup")).toBe(true);
  expect(document.getElementById("disclosureView")?.classList.contains("active")).toBe(false);
  expect(query).toHaveBeenCalledWith({ url: "chrome-extension://test/src/welcome/index.html", currentWindow: true });
  guideOpen = false;
  await vi.waitFor(() => expect(document.getElementById("authView")?.classList.contains("guided-setup")).toBe(false), { timeout: 3000 });
  expect(document.getElementById("authView")?.classList.contains("active")).toBe(true);
});

it("reviews the wrong profile's data removal before confirming a household correction", async () => {
  vi.resetModules();
  vi.useFakeTimers();
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/src/popup/popup.html`, "utf8");
  const confirmation = {
    memberDisplayName: "Vishal", provider: "atmos", operationId: "atmos-vishal-run",
    manualConversionRequired: false, collisionMemberDisplayName: "Jordan",
  };
  let pending: typeof confirmation | null = confirmation;
  let finishCorrection: ((value: { ok: boolean }) => void) | undefined;
  const correctionFinished = new Promise<{ ok: boolean }>((resolve) => { finishCorrection = resolve; });
  let correctionAttempts = 0;
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    switch (message.type) {
      case "GET_AUTH_STATE": return { token: "token", email: "owner@example.com", signedInAt: "test" };
      case "GET_EXTENSION_PROFILE": return { accountLevel: "pro", offersFirstUiEnabled: true };
      case "GET_HOUSEHOLD_STATE": return {
        context: {
          protocolVersion: 2, accountScopeId: "owner", contextRevision: "revision-1",
          primaryMemberId: "vishal", householdActivated: true,
          capabilities: { householdReads: true, householdWrites: true, loyaltyReads: true,
            loyaltyWrites: true, memberIssuerCardSync: true, memberOfferReads: true,
            memberOfferWrites: true, combinedReads: true },
          members: [{ id: "vishal", displayName: "Vishal", isPrimary: true, lifecycleVersion: 1 },
            { id: "jordan", displayName: "Jordan", isPrimary: false, lifecycleVersion: 1 }],
        }, selectedMemberId: "vishal", pendingConfirmation: pending,
      };
      case "CONFIRM_HOUSEHOLD_SYNC":
        correctionAttempts++;
        return correctionAttempts === 1 ? { ok: false, error: "Temporary network error" } : correctionFinished;
      default: return null;
    }
  });
  vi.stubGlobal("chrome", {
    runtime: { sendMessage, onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.8.6" }), getURL: (path: string) => path },
    storage: { local: { get: async () => ({ disclosureAccepted: true, consentGiven: true, firstSyncCompleted: true }), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} } },
    tabs: { create: vi.fn() }, windows: { getCurrent: async () => ({ id: 1 }) },
  });
  await import("./app");
  const correct = document.getElementById("householdSyncCorrection");
  const confirm = document.getElementById("householdSyncConfirmationConfirm");
  const memberSelect = document.getElementById("householdMemberSelect");
  if (!(correct instanceof HTMLButtonElement) || !(confirm instanceof HTMLButtonElement) || !(memberSelect instanceof HTMLSelectElement)) throw new Error("Missing profile controls");
  await vi.waitFor(() => expect(correct.textContent).toBe("Sync to Vishal"));
  correct.click();
  await vi.waitFor(() => expect(confirm.textContent).toBe("Clear and sync"));
  expect(document.getElementById("householdSyncConfirmationText")?.textContent).toContain("from Jordan, then sync this login to Vishal");
  expect(sendMessage.mock.calls.some(([message]) => message.type === "CONFIRM_HOUSEHOLD_SYNC")).toBe(false);
  document.getElementById("householdSyncConfirmationCancel")?.click();
  await vi.waitFor(() => expect(confirm.textContent).toBe("Keep on Jordan"));
  correct.click();
  await vi.waitFor(() => expect(confirm.textContent).toBe("Clear and sync"));
  confirm.click();
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
    type: "CONFIRM_HOUSEHOLD_SYNC", correctProfile: true, operationId: "atmos-vishal-run",
  }));
  await vi.waitFor(() => expect(confirm.disabled).toBe(false));
  expect(confirm.textContent).toBe("Clear and sync");
  confirm.click();
  await vi.waitFor(() => expect(correctionAttempts).toBe(2));
  expect(sendMessage.mock.calls.filter(([message]) => message.type === "CONFIRM_HOUSEHOLD_SYNC")
    .every(([message]) => message.correctProfile === true)).toBe(true);
  expect(confirm.disabled).toBe(true);
  expect(memberSelect.disabled).toBe(true);
  pending = null;
  finishCorrection?.({ ok: true });
  await vi.waitFor(() => expect(document.getElementById("householdSyncConfirmation")?.hidden).toBe(true));
});

it.each([true, false])("guides BofA through review and rewards handoff, activate=%s", async (activate) => {
  vi.resetModules(); vi.useFakeTimers();
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/src/popup/popup.html`, "utf8");
  type PortalState = import("../providers/bofa-offers").BofaPortalState;
  function makeState(phase: PortalState["phase"]): PortalState {
    return { runId: "bofa-guided", phase, total: 1, checked: 1, discovered: 1, added: 0, failed: 0,
      error: null, saveStatus: "saved", offers: [{ issuerOfferId: "1", merchantName: "Merchant", offerValue: "10% cash back",
        detailsText: "Eligible purchases", termsText: "Issuer terms", category: null, expirationDate: null,
        rewardType: "percentage", rewardAmount: 10, rewardCurrency: "cash", maxReward: null, minSpend: null,
        merchantUrl: null, merchantLogoUrl: null, redemptionChannel: "online", action: "activate", activationExpiresAt: null }] };
  }
  let state: PortalState | null = null;
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    switch (message.type) {
      case "GET_AUTH_STATE": return { token: "test", email: "owner@example.com", signedInAt: "test" };
      case "GET_EXTENSION_PROFILE": return { accountLevel: "pro", offersFirstUiEnabled: true };
      case "RECORD_CONSENT": return { ok: true };
      case "GET_OFFER_OPERATION_STATUS": return { active: null, history: {} };
      case "GET_OFFER_ACTIVATION_USAGE": return { accountLevel: "pro", used: 0, remaining: null, limit: null };
      case "BOFA_PORTAL_CHECK": state = makeState("checking"); return { ok: true, state };
      case "BOFA_PORTAL_ACTIVATE": state = makeState("activating"); return { ok: true, state };
      case "BOFA_PORTAL_FINISH": state = { ...makeState("ready"), reviewFinished: true }; return { ok: true, state };
      case "BOFA_PORTAL_STATUS": return { ok: true, state };
      default: return null;
    }
  });
  vi.stubGlobal("chrome", {
    runtime: { sendMessage, onMessage: { addListener() {} }, getManifest: () => ({ version: "0.8.7" }), getURL: (path: string) => path },
    storage: { local: { get: async () => ({ disclosureAccepted: true, consentGiven: true, offerConsentVersion: activate ? 0 : 100 }), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {}, removeListener() {} } },
    tabs: { create: vi.fn() }, windows: { getCurrent: async () => ({ id: 1 }) },
  });
  const app = await import("./app");
  const { mountBofaOffers } = await import("./bofa-offers");
  mountBofaOffers({ onStateChange: app.updateBofaOffersSetup, requestCheck: app.requestBofaOfferCheck, otherToolsBusy: app.areOtherOfferToolsBusy });
  await vi.waitFor(() => expect(document.getElementById("toolsTabPanel")?.dataset.guidedStage).toBe("choose_issuer"));
  document.getElementById("bofaOffersStartBtn")?.click();
  if (activate) {
    await vi.waitFor(() => expect(document.getElementById("consentModal")?.classList.contains("visible")).toBe(true));
    expect(sendMessage.mock.calls.some(([message]) => message.type === "BOFA_PORTAL_CHECK")).toBe(false);
    expect(document.getElementById("consentBody")?.textContent).toContain("deals portal");
    document.getElementById("consentCheckbox")?.click();
    document.getElementById("consentContinueBtn")?.click();
  }
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "BOFA_PORTAL_CHECK" }));
  expect(document.getElementById("toolsTabPanel")?.dataset.guidedStage).toBe("check_offers");
  expect(document.getElementById("bofaOffersCard")?.classList.contains("guided-active-issuer")).toBe(true);
  expect(document.getElementById("chaseOffersCard")?.classList.contains("guided-active-issuer")).toBe(false);
  state = makeState("ready");
  await vi.advanceTimersByTimeAsync(1600);
  expect(document.getElementById("toolsTabPanel")?.dataset.guidedStage).toBe("review_offers");
  const root = document.getElementById("bofaOffersCard");
  const buttons = () => Array.from(root?.querySelectorAll("button") ?? []);
  if (activate) {
    buttons().find((button) => button.textContent === "Activate all 1 offer")?.click();
    expect(root?.querySelector("[role=dialog]")?.textContent).toContain("Activate 1 offer");
    expect(sendMessage.mock.calls.some(([message]) => message.type === "BOFA_PORTAL_ACTIVATE")).toBe(false);
    const confirm = root?.querySelector(".offer-confirm-modal .consent-btn");
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("Missing confirmation");
    confirm.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: "BOFA_PORTAL_ACTIVATE", runId: "bofa-guided", ids: ["1"] }));
    state = { ...makeState("completed"), added: 1 };
    await vi.advanceTimersByTimeAsync(1600);
  } else {
    buttons().find((button) => button.textContent === "Done")?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendMessage.mock.calls.some(([message]) => message.type === "BOFA_PORTAL_ACTIVATE")).toBe(false);
  }
  expect(document.getElementById("toolsTabPanel")?.dataset.guidedStage).toBe("sync_rewards");
  expect(document.getElementById("offersSetupRewardsActions")?.hidden).toBe(false);
  expect(root?.classList.contains("guided-active-issuer")).toBe(false);
  window.dispatchEvent(new Event("pagehide"));
});
