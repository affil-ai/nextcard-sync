/**
 * Content script for aa.com (American Airlines AAdvantage).
 * Runs in ISOLATED WORLD.
 */

import type { AALoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("aa");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();
  const hostname = window.location.hostname.toLowerCase();

  // AA uses a separate login domain: login.aa.com
  if (hostname === "login.aa.com") {
    return "logged_out";
  }

  // Check for login/signin paths on www.aa.com
  if (url.includes("/login") || url.includes("/signin")) {
    return "logged_out";
  }

  // Account pages indicate logged in
  if (url.includes("/aadvantage-program/profile") || url.includes("/account-summary")) {
    return "logged_in";
  }

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

// ── Scrape account page ─────────────────────────────────────

function scrapeAccountPage(): AALoyaltyData {
  const data: AALoyaltyData = {
    milesBalance: null,
    eliteStatus: null,
    loyaltyPoints: null,
    loyaltyPointsToNextTier: null,
    prevYearLoyaltyPoints: null,
    millionMilerMiles: null,
    memberName: null,
    memberNumber: null,
  };

  try {
    data.memberName = document.querySelector('[class*="_member-name_"]')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard AA] memberName:", e); }

  try {
    const numEl = document.querySelector('[class*="_aadvantage-number_"]');
    const raw = numEl?.textContent?.trim() ?? '';
    data.memberNumber = raw.startsWith('#') ? raw.slice(1) : raw || null;
  } catch (e) { console.warn("[NextCard AA] memberNumber:", e); }

  try {
    const milesEl = document.querySelector('.reward-miles');
    if (milesEl) data.milesBalance = parseIntSafe(milesEl.textContent?.trim() ?? '');
  } catch (e) { console.warn("[NextCard AA] milesBalance:", e); }

  try {
    data.eliteStatus = document.querySelector('[class*="_aadvantage-member_"]')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard AA] eliteStatus:", e); }

  try {
    const lpEl = document.querySelector('[class*="_points-number_"]');
    if (lpEl) {
      const lpText = lpEl.childNodes[0]?.textContent?.trim() ?? '';
      data.loyaltyPoints = parseIntSafe(lpText);
    }
  } catch (e) { console.warn("[NextCard AA] loyaltyPoints:", e); }

  try {
    data.loyaltyPointsToNextTier = document.querySelector('[class*="_points-to-reach_"]')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard AA] loyaltyPointsToNextTier:", e); }

  try {
    data.prevYearLoyaltyPoints = document.querySelector('[data-testid="last-year-summary-msg"]')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard AA] prevYearLoyaltyPoints:", e); }

  try {
    const mmText = document.querySelector('[class*="_million-miles_"]')?.textContent?.trim() ?? '';
    const mmMatch = mmText.match(/([\d,]+)\s*miles/i);
    if (mmMatch) data.millionMilerMiles = parseIntSafe(mmMatch[1]);
  } catch (e) { console.warn("[NextCard AA] millionMilerMiles:", e); }

  // TODO: Scrape travel credits from /aadvantage-program/profile/travel-credits
  // (separate page — need a test account with active credits to build selectors)

  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "aa");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "aa");
  updateOverlayProgress("Reading miles and loyalty points...");
  await waitForSelector(".reward-miles, [class*='_member-name_']", 20000);
  await runControl.sleep(3000, attemptId);

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
    sendResponse({ state: monitor.getState() });
  }
  return true;
});

let syncActive = false;
const monitor = createLoginStateMonitor({
  provider: "aa",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "aa");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "aa");
    } else {
      updateOverlay("waiting_for_login", "aa");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "aa" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "aa");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "aa");
  }
});
