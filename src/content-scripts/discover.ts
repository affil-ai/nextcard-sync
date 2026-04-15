/**
 * Content script for discover.com (Discover credit cards).
 * Runs in ISOLATED WORLD.
 */

import type { DiscoverLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";

const runControl = createContentScriptRunControl("discover");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  // Login / logoff pages
  if (url.includes("/login") || url.includes("/logoff") || url.includes("/logon")) {
    return "logged_out";
  }

  // Account dashboard means logged in
  if (url.includes("card.discover.com/web/achome")) {
    return "logged_in";
  }

  // Fallback: check for authenticated dashboard element
  const header = document.querySelector('[data-testid="headerContainer"]');
  if (header) return "logged_in";

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

function parseCurrency(str: string): number | null {
  const cleaned = str.replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

// ── Scrape account page ─────────────────────────────────────

function scrapeAccountPage(): DiscoverLoyaltyData {
  const data: DiscoverLoyaltyData = {
    cardName: null,
    lastFourDigits: null,
    cashbackBalance: null,
  };

  // ── Last four digits + card name ──
  // data-testid="headerCardDetails" → "Card Details (Account ending in 5022)"
  try {
    const cardDetails = document.querySelector('[data-testid="headerCardDetails"]');
    if (cardDetails) {
      const text = cardDetails.textContent?.trim() ?? "";
      const match = text.match(/(\d{4})\)?$/);
      if (match) data.lastFourDigits = match[1];
      data.cardName = text;
    }
  } catch (e) { console.warn("[NextCard Discover] cardDetails:", e); }

  // ── Cashback balance ──
  // data-testid="rewardsBalance" → "$2.25"
  try {
    const rewardsEl = document.querySelector('[data-testid="rewardsBalance"]');
    if (rewardsEl) {
      data.cashbackBalance = parseCurrency(rewardsEl.textContent?.trim() ?? "");
    }
  } catch (e) { console.warn("[NextCard Discover] cashbackBalance:", e); }

  console.log("[NextCard Discover] Scraped data:", data);
  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  console.log("[NextCard Discover] Login state:", loginState);
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
    showOverlay("waiting_for_login", "discover");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "discover");
  updateOverlayProgress("Reading cashback balance...");
  console.log("[NextCard Discover] Waiting for account content...");
  await waitForSelector('[data-testid="rewardsBalance"], [data-testid="headerCardDetails"]', 20000);
  await runControl.sleep(2000, attemptId);
  const discoverCardEl = document.querySelector('[data-testid="headerCardDetails"]');
  if (discoverCardEl) updateOverlayProgress(`Syncing ${discoverCardEl.textContent?.trim()}...`);

  runControl.throwIfCancelled(attemptId);
  const data = scrapeAccountPage();
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
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "discover" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "discover");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "discover");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "discover", state: initialState }).catch(() => {});
console.log("[NextCard Discover] Content script loaded. Login state:", initialState);
