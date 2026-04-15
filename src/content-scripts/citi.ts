/**
 * Content script for online.citi.com (Citi credit cards).
 * Runs in ISOLATED WORLD.
 *
 * Scrapes all card tiles and their associated rewards from the dashboard.
 * Citi shows all cards + rewards on a single page — no navigation needed.
 */

import type { CitiLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";

const runControl = createContentScriptRunControl("citi");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  // Login page
  if (url.includes("citi.com/login") || url.includes("/logon") || url.includes("/signin")) {
    return "logged_out";
  }

  // Dashboard means logged in
  if (url.includes("online.citi.com/us/ag/dashboard")) {
    return "logged_in";
  }

  // Fallback: check for greeting header
  const greeting = document.getElementById("dashboardWelcomeHeader");
  if (greeting) return "logged_in";

  return "unknown";
}

// ── Wait for content to render ───────────────────────────────

function waitForSelector(selector: string, maxWaitMs = 15000): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, maxWaitMs);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ── Helpers ──────────────────────────────────────────────────

function parseIntSafe(str: string): number | null {
  const n = parseInt(str.replace(/[,\s]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

// ── Scrape dashboard ────────────────────────────────────────

function scrapeDashboard(): CitiLoyaltyData {
  const cards: CitiLoyaltyData["cards"] = [];

  // Each card is a <dashboard-account-selector-tile> with id like cardAccountSelector0Tile
  const tiles = document.querySelectorAll("dashboard-account-selector-tile");

  for (const tile of tiles) {
    const nameEl = tile.querySelector("h3.account-name");
    const cardName = nameEl?.textContent?.trim() ?? null;

    // Last 4 from aria-label "Account ending in XXXX"
    const endingEl = tile.querySelector('[aria-label^="Account ending"]');
    const ariaLabel = endingEl?.getAttribute("aria-label") ?? "";
    const lastFourMatch = ariaLabel.match(/(\d{4})$/);
    const lastFourDigits = lastFourMatch ? lastFourMatch[1] : null;

    cards.push({
      cardName,
      lastFourDigits,
      rewardsBalance: null,
      rewardsLabel: null,
    });
  }

  // Rewards are in .reward-wrapper sections, linked to cards via "for card ending in XXXX"
  const rewardWrappers = document.querySelectorAll(".reward-wrapper");
  for (const wrapper of rewardWrappers) {
    const heading = wrapper.querySelector(".reward-heading")?.textContent?.trim() ?? "";
    const subheading = wrapper.querySelector(".reward-subheading")?.textContent?.trim() ?? "";

    // Match to a card by last 4 digits
    const cardMatch = subheading.match(/(\d{4})/);
    const rewardLastFour = cardMatch ? cardMatch[1] : null;

    // Get the numeric value from .reward-amount first child span
    const amountEl = wrapper.querySelector(".reward-amount");
    const valueSpan = amountEl?.querySelector("span:first-child");
    const rewardsBalance = valueSpan ? parseIntSafe(valueSpan.textContent?.trim() ?? "") : null;

    // Determine label: "ThankYou Points", "Miles", "Business Miles"
    let rewardsLabel: string | null = null;
    if (heading.includes("ThankYou")) rewardsLabel = "ThankYou Points";
    else if (heading.includes("Business Miles")) rewardsLabel = "Business Miles";
    else if (heading.includes("Miles")) rewardsLabel = "Miles";

    // Link to matching card
    if (rewardLastFour) {
      const card = cards.find((c) => c.lastFourDigits === rewardLastFour);
      if (card) {
        card.rewardsBalance = rewardsBalance;
        card.rewardsLabel = rewardsLabel;
      }
    }
  }

  console.log("[NextCard Citi] Scraped data:", { cards });
  return { cards };
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  console.log("[NextCard Citi] Login state:", loginState);
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
    showOverlay("waiting_for_login", "citi");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "citi");
  updateOverlayProgress("Reading card accounts...");
  console.log("[NextCard Citi] Waiting for dashboard content...");
  await waitForSelector("dashboard-account-selector-tile, #dashboardWelcomeHeader", 20000);
  await runControl.sleep(3000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const data = scrapeDashboard();
  await runControl.sendMessage(attemptId, { type: "EXTRACTION_DONE", data });
}

// ── Message listener ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (runControl.handleAbort(message)) {
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "START_EXTRACTION") {
    if (typeof message.attemptId !== "string") {
      sendResponse({ ok: false });
      return true;
    }
    runControl.beginAttempt(message.attemptId);
    runExtraction(message.attemptId);
    sendResponse({ ok: true });
  }
  if (message.type === "GET_LOGIN_STATE") {
    sendResponse({ state: detectLoginState() });
  }
  return true;
});

const initialState = detectLoginState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "citi" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "citi");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "citi");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "citi", state: initialState }).catch(() => {});
console.log("[NextCard Citi] Content script loaded. Login state:", initialState);
