/**
 * Content script for delta.com (Delta SkyMiles).
 * Runs in ISOLATED WORLD.
 */

import type { DeltaLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("delta");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  // Delta login page
  if (url.includes("/skymiles/login") || url.includes("/login")) {
    return "logged_out";
  }

  // 2FA / verification pages
  if (url.includes("/verify") || url.includes("/challenge") || url.includes("/mfa")) {
    return "logged_out";
  }

  // Account/profile/skymiles pages indicate logged in
  if (url.includes("/my-profile") || url.includes("/myprofile") || url.includes("/myskymiles")) {
    return "logged_in";
  }

  // Check for logged-in indicators in the DOM (header shows name when logged in)
  const paxName = document.querySelector('.pax-name');
  if (paxName) return "logged_in";

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
  const n = parseInt(str.replace(/[,\s$]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

function parseDollarAmount(str: string): number | null {
  const match = str.match(/\$([\d,]+)/);
  if (!match) return null;
  return parseIntSafe(match[1]);
}

// ── Scrape account page ─────────────────────────────────────

function scrapeAccountPage(): DeltaLoyaltyData {
  const data: DeltaLoyaltyData = {
    milesBalance: null,
    eliteStatus: null,
    memberSince: null,
    mqds: null,
    mqdsToNextTier: null,
    lifetimeMiles: null,
    deltaAmexCard: null,
    memberName: null,
    memberNumber: null,
  };

  // Each section wrapped in try/catch so a missing/changed element never kills the whole scrape

  try {
    data.memberName = document.querySelector('.pax-name')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Delta] memberName:", e); }

  try {
    const wrappers = document.querySelectorAll('.skymiles-medallion-banner__details__container__right__skymiles-wrapper');
    for (const w of wrappers) {
      const title = w.querySelector('.skymiles-medallion-banner__details__container__right__skymiles-wrapper__title')?.textContent?.trim();
      const value = w.querySelector('.skymiles-medallion-banner__details__container__right__skymiles-wrapper__subtitle')?.textContent?.trim();
      if (!title || !value) continue;
      if (title.includes('SKYMILES #')) data.memberNumber = value;
      if (title.includes('MILES AVAILABLE')) data.milesBalance = parseIntSafe(value);
    }
  } catch (e) { console.warn("[NextCard Delta] banner wrappers:", e); }

  try {
    data.eliteStatus = document.querySelector('.skymiles-medallion-banner__status__container__tier__wrapper__subtitle')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Delta] eliteStatus:", e); }

  try {
    const sinceText = document.querySelector('.skymiles-medallion-banner__status__container__tier__enroll-date')?.textContent?.trim() ?? '';
    const sinceMatch = sinceText.match(/SINCE\s+(\d{4})/i);
    if (sinceMatch) data.memberSince = sinceMatch[1];
  } catch (e) { console.warn("[NextCard Delta] memberSince:", e); }

  try {
    data.mqdsToNextTier = document.querySelector('.aura-tracker-journey__qualifier')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Delta] mqdsToNextTier:", e); }

  try {
    const entryItems = document.querySelectorAll('aura-entry-item');
    let foundMqdSummary = false;
    for (const item of entryItems) {
      const title = item.querySelector('[data-cy="entry-item-content-title-id"]')?.textContent?.trim();
      const amount = item.querySelector('.aura-entry-item__value__amount')?.textContent?.trim();

      if (title === 'MQD Earning Summary') { foundMqdSummary = true; continue; }
      if (title === 'Recent Account Activity') break;

      if (foundMqdSummary && amount && amount.startsWith('$') && data.mqds === null) {
        data.mqds = parseDollarAmount(amount);
      }
    }
  } catch (e) { console.warn("[NextCard Delta] MQDs/activity:", e); }

  try {
    const subs = document.querySelectorAll('.skymiles-landing-page-tracker__container__wrap__content__subheading');
    for (const sh of subs) {
      const label = sh.textContent?.trim()?.toUpperCase();
      const wrap = sh.closest('.skymiles-landing-page-tracker__container__wrap__content');
      const value = wrap?.querySelector('.skymiles-landing-page-tracker__container__wrap__content__number')?.textContent?.trim();
      if (label?.includes('MILLION MILER') && value) data.lifetimeMiles = parseIntSafe(value);
    }
  } catch (e) { console.warn("[NextCard Delta] lifetimeMiles:", e); }

  try {
    data.deltaAmexCard = document.querySelector('.banner-container__title')?.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Delta] deltaAmexCard:", e); }

  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "delta");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "delta");
  updateOverlayProgress("Reading miles and Medallion status...");
  // Wait for the overview page trackers or fall back to the banner
  await waitForSelector(".skymiles-landing-page-tracker, .skymiles-medallion-banner", 20000);
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
  provider: "delta",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "delta");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "delta");
    } else {
      updateOverlay("waiting_for_login", "delta");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "delta" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "delta");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "delta");
  }
});
