/**
 * Content script for united.com (United MileagePlus).
 * Runs in ISOLATED WORLD.
 */

import type { UnitedLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay } from "../lib/overlay";

const runControl = createContentScriptRunControl("united");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  // United sign-in page (two-step: email → password)
  if (url.includes("/mileageplus-signin") || url.includes("/login") || url.includes("/signin")) {
    return "logged_out";
  }

  // 2FA / verification pages
  if (url.includes("/verify") || url.includes("/challenge") || url.includes("/mfa")) {
    return "logged_out";
  }

  // MileagePlus account pages indicate logged in
  if (url.includes("/myunited") || (url.includes("/mileageplus/") && !url.includes("signin"))) {
    return "logged_in";
  }

  // Check for logged-in indicators in the DOM
  const signInBtn = document.querySelector('#loginButton');
  if (signInBtn) return "logged_out";

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

function scrapeAccountPage(): UnitedLoyaltyData {
  const data: UnitedLoyaltyData = {
    milesBalance: null,
    eliteStatus: null,
    pqps: null,
    pqfs: null,
    lifetimeMiles: null,
    travelBankBalance: null,
    memberName: null,
    memberNumber: null,
  };

  try {
    const milesEl = document.querySelector('[class*="MileageBalance__totalMiles"]');
    if (milesEl) data.milesBalance = parseIntSafe(milesEl.textContent?.trim() ?? '');
  } catch (e) { console.warn("[NextCard United] milesBalance:", e); }

  try {
    const numEl = document.querySelector('[class*="accountSummary__mpNumber"]');
    if (numEl) {
      const raw = numEl.textContent?.replace(/MileagePlus Number/i, '').trim() ?? '';
      data.memberNumber = raw || null;
    }
  } catch (e) { console.warn("[NextCard United] memberNumber:", e); }

  try {
    const greeting = document.querySelector('h2[class*="box-section__title"]');
    const match = greeting?.textContent?.match(/Hello,\s*(.+)/i);
    if (match) data.memberName = match[1].trim();
  } catch (e) { console.warn("[NextCard United] memberName:", e); }

  try {
    const pqfEl = document.querySelector('[class*="PremierProgress__pqf"]');
    const pqfVal = pqfEl?.querySelector('[class*="__value"]')?.textContent?.trim();
    if (pqfVal) data.pqfs = parseIntSafe(pqfVal);
  } catch (e) { console.warn("[NextCard United] pqfs:", e); }

  try {
    const pqpEl = document.querySelector('[class*="PremierProgress__pqp"]');
    const pqpVal = pqpEl?.querySelector('[class*="__value"]')?.textContent?.trim();
    if (pqpVal) data.pqps = parseIntSafe(pqpVal);
  } catch (e) { console.warn("[NextCard United] pqps:", e); }

  try {
    const ltmEl = document.querySelector('[class*="PremierProgress__lifeTimeMiles"]');
    const ltmVal = ltmEl?.querySelector('[class*="__value"]')?.textContent?.trim();
    if (ltmVal) data.lifetimeMiles = parseIntSafe(ltmVal);
  } catch (e) { console.warn("[NextCard United] lifetimeMiles:", e); }

  try {
    // TravelBank balance lives inside the wallet card (TravelBank-styles__traveBankContainer).
    // There can be a second travelBankBalance element in the AccountSummaryDetails section
    // that shows expiring funds instead of the total — target the wallet card specifically.
    const tbCard = document.querySelector('[class*="traveBankContainer"]');
    const tbBalanceEl = tbCard?.querySelector('[class*="travelBankBalance"]')
      ?? document.querySelector('[class*="travelBankBalance"]');
    if (tbBalanceEl) {
      // If the element contains child elements (e.g. total + expiry), grab just the first dollar amount
      const text = tbBalanceEl.textContent?.trim() ?? '';
      const match = text.match(/\$[\d,]+(?:\.\d{2})?/);
      data.travelBankBalance = match ? match[0] : text || null;
    }
  } catch (e) { console.warn("[NextCard United] travelBankBalance:", e); }

  // eliteStatus: base members don't have a Premier status label shown;
  // for Premier members it would appear in the progress section header
  try {
    const statusEl = document.querySelector('[class*="PremierProgress__headerText"]');
    const statusText = statusEl?.textContent?.trim() ?? '';
    if (statusText.toLowerCase().includes('premier')) {
      const match = statusText.match(/Premier\s+(Silver|Gold|Platinum|1K)/i);
      data.eliteStatus = match ? `Premier ${match[1]}` : 'MileagePlus Member';
    } else {
      data.eliteStatus = 'MileagePlus Member';
    }
  } catch (e) { console.warn("[NextCard United] eliteStatus:", e); }

  console.log("[NextCard United] Scraped data:", data);
  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  console.log("[NextCard United] Login state:", loginState);
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
    showOverlay("waiting_for_login", "united");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "united");
  console.log("[NextCard United] Waiting for account content...");
  await waitForSelector('[class*="MileageBalance"], [class*="accountSummary"]', 20000);
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
    sendResponse({ state: detectLoginState() });
  }
  return true;
});

const initialState = detectLoginState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "united" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "united");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "united");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "united", state: initialState }).catch(() => {});
console.log("[NextCard United] Content script loaded. Login state:", initialState);
