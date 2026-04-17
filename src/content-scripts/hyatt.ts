/**
 * Content script for hyatt.com (World of Hyatt).
 * Runs in ISOLATED WORLD.
 *
 * Two-phase scrape orchestrated by the service worker:
 *   1. Account Overview (/profile/en-US/account-overview) → EXTRACTION_DONE
 *   2. Awards page (/profile/en-US/awards) → AWARDS_SCRAPED
 */

import type { HyattLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("hyatt");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  // Sign-in pages
  if (url.includes("/sign-in") || url.includes("/login") || url.includes("/signin")) {
    return "logged_out";
  }

  // Account/profile pages indicate logged in
  if (url.includes("/profile/") || url.includes("/loyalty/")) {
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

// ── Scrape account overview page ─────────────────────────────

function scrapeAccountPage(): HyattLoyaltyData {
  const data: HyattLoyaltyData = {
    pointsBalance: null,
    eliteStatus: null,
    qualifyingNights: null,
    basePoints: null,
    memberSince: null,
    memberName: null,
    memberNumber: null,
    validatedThrough: null,
    milestoneNights: null,
    milestoneProgress: null,
    milestoneTotal: null,
    milestoneChoices: [],
    awards: [],
  };

  // Points balance — data-locator="points-balance"
  try {
    const el = document.querySelector('[data-locator="points-balance"]');
    if (el) data.pointsBalance = parseIntSafe(el.textContent?.trim() ?? "");
  } catch (e) { console.warn("[NextCard Hyatt] pointsBalance:", e); }

  // Elite status / tier — data-locator="type"
  try {
    const el = document.querySelector('[data-locator="type"]');
    if (el) data.eliteStatus = el.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Hyatt] eliteStatus:", e); }

  // Member name — data-locator="name"
  try {
    const el = document.querySelector('[data-locator="name"]');
    if (el) data.memberName = el.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Hyatt] memberName:", e); }

  // Member number — data-locator="member-number"
  try {
    const el = document.querySelector('[data-locator="member-number"]');
    if (el) data.memberNumber = el.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Hyatt] memberNumber:", e); }

  // Member since — data-locator="status" (e.g. "Member since Jan 2, 2022" or "Globalist through Feb 28, 2027")
  try {
    const statusEls = document.querySelectorAll('[data-locator="status"]');
    for (const el of statusEls) {
      const text = el.textContent?.trim() ?? "";
      if (text.toLowerCase().includes("member since")) {
        data.memberSince = text;
      }
      const throughMatch = text.match(/through\s+(.+)/i);
      if (throughMatch) {
        data.validatedThrough = throughMatch[1].trim();
      }
    }
  } catch (e) { console.warn("[NextCard Hyatt] memberSince:", e); }

  // Year-to-date progress — data-locator="pointBox"
  // Hyatt renders the number twice (desktop + mobile responsive spans), so
  // reading textContent concatenates them (e.g. "22Qualifying Nights" for 2 nights).
  // Instead, read from the desktop-only element with the PointBox_points class.
  try {
    const boxes = document.querySelectorAll('[data-locator="pointBox"]');
    for (const box of boxes) {
      const text = box.textContent?.toLowerCase() ?? "";
      const pointsEl = box.querySelector('[class*="PointBox_points"]');
      const value = pointsEl ? parseIntSafe(pointsEl.textContent?.trim() ?? "") : null;

      if (text.includes("qualifying nights")) {
        data.qualifyingNights = value;
      } else if (text.includes("base points")) {
        data.basePoints = value;
      }
    }
  } catch (e) { console.warn("[NextCard Hyatt] yearProgress:", e); }

  // Milestone progress — count how many milestone thresholds the user has reached.
  // Each milestone can be reached via qualifying nights OR base points.
  // The page-tracker element is a carousel pagination indicator, NOT milestone progress.
  try {
    const milestoneLabels = document.querySelectorAll('[data-locator="milestone-timeline"] [data-locator="milestone-label"]');
    if (milestoneLabels.length > 0) {
      data.milestoneTotal = milestoneLabels.length;
      let reached = 0;
      for (const label of milestoneLabels) {
        const nightsEl = label.querySelector('[data-locator="nights-threshold"]');
        const pointsEl = label.querySelector('[data-locator="points-threshold"]');
        const nightsMatch = nightsEl?.textContent?.match(/(\d[\d,]*)\s*Nights/i);
        const pointsMatch = pointsEl?.textContent?.match(/([\d,]+)\s*Base Points/i);
        const nightsThreshold = nightsMatch ? parseIntSafe(nightsMatch[1]) : null;
        const pointsThreshold = pointsMatch ? parseIntSafe(pointsMatch[1]) : null;
        const metNights = nightsThreshold != null && data.qualifyingNights != null && data.qualifyingNights >= nightsThreshold;
        const metPoints = pointsThreshold != null && data.basePoints != null && data.basePoints >= pointsThreshold;
        if (metNights || metPoints) reached++;
      }
      data.milestoneProgress = reached;
    }
  } catch (e) { console.warn("[NextCard Hyatt] milestoneProgress:", e); }

  // Milestone nights from previous year section — data-locator="title"
  try {
    const prevYear = document.querySelector('[data-locator="milestones-previous-year"]');
    if (prevYear) {
      const title = prevYear.querySelector('[data-locator="title"]');
      const nightsMatch = title?.textContent?.match(/(\d+)\s*Nights?\s*Milestone/i);
      if (nightsMatch) data.milestoneNights = parseInt(nightsMatch[1], 10);
    }
  } catch (e) { console.warn("[NextCard Hyatt] milestoneNights:", e); }

  // Milestone choices — from both current and previous year sections
  try {
    // Current year choices: data-locator="milestones-current-year" > data-locator="award"
    const currentYear = document.querySelector('[data-locator="milestones-current-year"]');
    if (currentYear) {
      const awards = currentYear.querySelectorAll('[data-locator="award"]');
      for (const award of awards) {
        const name = award.querySelector('[data-locator="name"]')?.textContent?.trim();
        const description = award.querySelector('[data-locator="description"]')?.textContent?.trim() ?? null;
        if (name) data.milestoneChoices.push({ name, description });
      }
    }

    // Previous year choices (if form is expanded): data-locator="choice-submit-form"
    if (data.milestoneChoices.length === 0) {
      const form = document.querySelector('[data-locator="choice-submit-form"]');
      if (form) {
        const awards = form.querySelectorAll('[data-locator="award-info"]');
        for (const award of awards) {
          const name = award.querySelector('[data-locator="name"]')?.textContent?.trim();
          const description = award.querySelector('[data-locator="description"]')?.textContent?.trim() ?? null;
          if (name) data.milestoneChoices.push({ name, description });
        }
      }
    }
  } catch (e) { console.warn("[NextCard Hyatt] milestoneChoices:", e); }

  return data;
}

// ── Scrape awards page ───────────────────────────────────────

type Award = { name: string; description: string | null; expiryDate: string | null };

function scrapeAwardsPage(): Award[] {
  const awards: Award[] = [];

  try {
    const awardLists = document.querySelectorAll('[data-locator="awardList"]');
    for (const list of awardLists) {
      // Group header (e.g. "Free Night Awards (1)")
      const header = list.querySelector('[class*="List_header"]');
      const groupName = header?.textContent?.trim() ?? "";

      // Individual award items: li with AwardsListItem class
      const items = list.querySelectorAll('li[class*="AwardsListItem"]');
      for (const item of items) {
        const name = item.querySelector('[data-locator="description"]')?.textContent?.trim();
        const expiryText = item.querySelector('[data-locator="expiration"]')?.textContent?.trim() ?? null;
        // Clean up "Expires " prefix
        const expiryDate = expiryText?.replace(/^Expires\s+/i, "") ?? null;

        if (name) {
          awards.push({
            name,
            description: groupName || null,
            expiryDate,
          });
        }
      }
    }
  } catch (e) { console.warn("[NextCard Hyatt] awards scrape:", e); }

  return awards;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "hyatt");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "hyatt");
  updateOverlayProgress("Reading points and tier progress...");
  await waitForSelector('[data-locator="points-balance"], [data-locator="type"]', 20000);
  await runControl.sleep(3000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const data = scrapeAccountPage();
  await runControl.sendMessage(attemptId, { type: "EXTRACTION_DONE", data });
}

async function runAwardsScrape(attemptId: string) {

  // Wait briefly for the page to render, then check if awards exist.
  // Some members (e.g. basic Member tier) may have no awards at all.
  const el = await waitForSelector('[data-locator="awardList"]', 8000);
  if (!el) {
    await runControl.sendMessage(attemptId, { type: "AWARDS_SCRAPED", awards: [] });
    return;
  }

  await runControl.sleep(1000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const awards = scrapeAwardsPage();
  await runControl.sendMessage(attemptId, { type: "AWARDS_SCRAPED", awards });
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
  if (message.type === "SCRAPE_AWARDS") {
    if (typeof message.attemptId !== "string") {
      sendResponse({ ok: false });
      return true;
    }
    runControl.beginAttempt(message.attemptId);
    runAwardsScrape(message.attemptId);
    sendResponse({ ok: true });
  }
  if (message.type === "GET_LOGIN_STATE") {
    sendResponse({ state: monitor.getState() });
  }
  return true;
});

let syncActive = false;
const monitor = createLoginStateMonitor({
  provider: "hyatt",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "hyatt");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "hyatt");
    } else {
      updateOverlay("waiting_for_login", "hyatt");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "hyatt" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "hyatt");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "hyatt");
  }
});
