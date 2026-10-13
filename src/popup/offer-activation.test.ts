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
  const sendMessage = vi.fn(async (message: Record<string, unknown>) => {
    switch (message.type) {
      case "GET_AUTH_STATE": return { token: "test-token", email: "test@example.com", signedInAt: "test" };
      case "GET_EXTENSION_PROFILE": return { accountLevel: "pro", offersFirstUiEnabled: true };
      case "GET_OFFER_ACTIVATION_USAGE": return { accountLevel: "pro", used: 0, remaining: null, limit: null };
      case "GET_OFFER_OPERATION_STATUS": return snapshot;
      case "START_OFFER_ENROLLMENT": return { ok: true };
      case "FINISH_OFFER_REVIEW": snapshot = { ...snapshot, active: null }; return { ok: true };
      default: return null;
    }
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage, onMessage: { addListener: () => {} }, getManifest: () => ({ version: "0.8.5" }), getURL: (path: string) => path },
    storage: { local: { get: async () => ({ disclosureAccepted: true, consentGiven: true, firstSyncCompleted: true,
      offersIntroVersion: 100, offerConsentVersion: 100 }), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} } },
    tabs: { create: vi.fn() }, windows: { getCurrent: async () => ({ id: 1 }) } });
  await import("./app");
  await vi.waitFor(() => expect(document.querySelectorAll("#chaseOffersReview input")).toHaveLength(1));
  const run = document.getElementById("chaseOffersRunBtn");
  if (!(run instanceof HTMLButtonElement)) throw new Error("Missing activation button");
  expect(run.disabled).toBe(true);
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
