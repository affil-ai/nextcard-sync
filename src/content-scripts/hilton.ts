/**
 * Content script for hilton.com (Hilton Honors).
 * Runs in ISOLATED WORLD.
 */

import type { HiltonLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay } from "../lib/overlay";

const runControl = createContentScriptRunControl("hilton");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  // Sign-in page or modal
  if (url.includes("/sign-in") || url.includes("/login")) {
    return "logged_out";
  }

  // Account pages indicate logged in
  if (url.includes("/hilton-honors/guest/")) {
    return "logged_in";
  }

  // Check for authenticated nav elements
  const accountLink = document.querySelector('[data-testid="account-link"], a[href*="/hilton-honors/guest/"]');
  if (accountLink) return "logged_in";

  const signInBtn = document.querySelector('[data-testid="sign-in-btn"], a[href*="sign-in"]');
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

function scrapeAccountPage(): HiltonLoyaltyData {
  const data: HiltonLoyaltyData = {
    pointsBalance: null,
    eliteStatus: null,
    nightsThisYear: null,
    nightsToNextTier: null,
    staysThisYear: null,
    staysToNextTier: null,
    spendThisYear: null,
    spendToNextTier: null,
    nextTierName: null,
    lifetimeNights: null,
    memberName: null,
    memberNumber: null,
    memberSince: null,
  };

  // ── Points balance ──
  // data-testid="honorsPointsBlock" contains a <span> with the number
  try {
    const pointsBlock = document.querySelector('[data-testid="honorsPointsBlock"]');
    if (pointsBlock) {
      const span = pointsBlock.querySelector('span');
      if (span) data.pointsBalance = parseIntSafe(span.textContent?.trim() ?? "");
    }
  } catch (e) { console.warn("[NextCard Hilton] pointsBalance:", e); }

  // ── Elite status / tier ──
  // data-testid="tierBlock" → first child div contains a .font-headline with tier name
  try {
    const tierBlock = document.querySelector('[data-testid="tierBlock"]');
    if (tierBlock) {
      const tierText = tierBlock.querySelector('.font-headline');
      if (tierText) data.eliteStatus = tierText.textContent?.trim() ?? null;
    }
  } catch (e) { console.warn("[NextCard Hilton] eliteStatus:", e); }

  // ── Member name ──
  // data-testid="firstNameLabel" contains the first name
  try {
    const nameEl = document.querySelector('[data-testid="firstNameLabel"]');
    if (nameEl) data.memberName = nameEl.textContent?.trim() ?? null;
  } catch (e) { console.warn("[NextCard Hilton] memberName:", e); }

  // ── Member number ──
  // data-testid="honorsNumberBlock" has aria-label="Hilton Honors number XXXXXXXXXX"
  try {
    const numBlock = document.querySelector('[data-testid="honorsNumberBlock"]');
    if (numBlock) {
      const ariaLabel = numBlock.getAttribute("aria-label") ?? "";
      const match = ariaLabel.match(/(\d{9,12})/);
      if (match) {
        data.memberNumber = match[1];
      } else {
        // Fallback: extract from text content
        const text = numBlock.textContent?.trim() ?? "";
        const textMatch = text.match(/(\d{9,12})/);
        if (textMatch) data.memberNumber = textMatch[1];
      }
    }
  } catch (e) { console.warn("[NextCard Hilton] memberNumber:", e); }

  // ── Tier progress ──
  // data-testid="newTierTrackerWrap" contains heading "Your progress to Silver"
  // data-testid="tier-tracker" elements contain "Nights 0 0 of 10", "Stays 0 0 of 4", etc.
  try {
    const progressWrap = document.querySelector('[data-testid="newTierTrackerWrap"]');
    if (progressWrap) {
      // Next tier name from heading
      const heading = progressWrap.querySelector('h2');
      if (heading) {
        const tierMatch = heading.textContent?.match(/progress\s+to\s+(Silver|Gold|Diamond)/i);
        if (tierMatch) data.nextTierName = tierMatch[1];
      }

      // Parse all three trackers: Nights, Stays, Spend
      const trackers = progressWrap.querySelectorAll('[data-testid="tier-tracker"]');
      for (const tracker of trackers) {
        const text = tracker.textContent?.trim() ?? "";
        const progressEl = tracker.querySelector('[data-testid="tier-tracker--progress"]');
        const progText = progressEl?.textContent?.trim() ?? "";

        if (text.includes("Nights")) {
          const match = progText.match(/(\d+)\s+of\s+(\d+)/);
          if (match) {
            data.nightsThisYear = parseIntSafe(match[1]);
            data.nightsToNextTier = parseIntSafe(match[2]);
          }
        } else if (text.includes("Stays")) {
          const match = progText.match(/(\d+)\s+of\s+(\d+)/);
          if (match) {
            data.staysThisYear = parseIntSafe(match[1]);
            data.staysToNextTier = parseIntSafe(match[2]);
          }
        } else if (text.includes("Spend")) {
          // Spend is "$0 of $2.5K" — keep as string
          data.spendThisYear = progText.match(/^(\$[\d,.]+[KMB]?)/)?.[1] ?? null;
          data.spendToNextTier = progText.match(/of\s+(\$[\d,.]+[KMB]?)/)?.[1] ?? null;
        }
      }
    }
  } catch (e) { console.warn("[NextCard Hilton] nightsProgress:", e); }

  // ── Member since ──
  // Not always visible on the account page; only scrape if present
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent?.trim() ?? "";
      const sinceMatch = text.match(/member\s+since\s+(\d{4})/i);
      if (sinceMatch) {
        data.memberSince = sinceMatch[1];
        break;
      }
    }
  } catch (e) { console.warn("[NextCard Hilton] memberSince:", e); }

  console.log("[NextCard Hilton] Scraped data:", data);
  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  console.log("[NextCard Hilton] Login state:", loginState);
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
    showOverlay("waiting_for_login", "hilton");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "hilton");
  console.log("[NextCard Hilton] Waiting for account content...");
  await waitForSelector('[data-testid="honorsPointsBlock"], [data-testid="tierBlock"], [data-testid="memberInfoBlock"]', 20000);
  await runControl.sleep(2000, attemptId);

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
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "hilton" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "hilton");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "hilton");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "hilton", state: initialState }).catch(() => {});
console.log("[NextCard Hilton] Content script loaded. Login state:", initialState);
