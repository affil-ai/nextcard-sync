/**
 * Content script for ultimaterewardspoints.chase.com (runs in ISOLATED WORLD).
 *
 * Scrapes card name, available points, and pending points from the UR dashboard.
 * The service worker navigates here with ?AI={accountId} for each UR-earning card.
 * Non-UR cards (e.g. Marriott Boundless) redirect away, which the service worker handles.
 */

import type { LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("chase");

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  if (url.includes("ultimaterewardspoints.chase.com")) {
    return "logged_in";
  }

  return "unknown";
}

function waitForSelector(selector: string, maxWaitMs = 20000): Promise<Element | null> {
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

function parseIntSafe(str: string): number | null {
  const n = parseInt(str.replace(/[,\s]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

function scrapeDashboard() {
  const data = {
    cardName: null as string | null,
    availablePoints: null as number | null,
    pendingPoints: null as number | null,
  };

  // Card name: div.mds-body-large-heavier inside .card-details
  // Contains text like "Chase Sapphire Reserve® (...2913)"
  const cardDetailsEl = document.querySelector(".card-details .mds-body-large-heavier");
  if (cardDetailsEl) {
    data.cardName = textOf(cardDetailsEl);
  }

  if (!data.cardName) {
    for (const el of document.querySelectorAll("[class*='mds-body']")) {
      const t = textOf(el);
      if (t.includes("®") && t.length > 5 && t.length < 80) {
        data.cardName = t;
        break;
      }
    }
  }

  // Points: span inside div.mds-title-large, inside div.points
  // Structure: div.points-balance > div.points > div.mds-title-large > span
  // Sibling span has "Available points" or "Pending points"
  for (const pointsDiv of document.querySelectorAll(".points-balance .points")) {
    const numEl = pointsDiv.querySelector(".mds-title-large span");
    if (!numEl) continue;
    const num = textOf(numEl);
    if (!/^-?[\d,]+$/.test(num)) continue;
    const context = pointsDiv.textContent?.toLowerCase() ?? "";
    if (context.includes("available") && data.availablePoints == null) {
      data.availablePoints = parseIntSafe(num);
    } else if (context.includes("pending") && data.pendingPoints == null) {
      data.pendingPoints = parseIntSafe(num);
    }
  }

  if (data.availablePoints == null) {
    for (const el of document.querySelectorAll("span")) {
      const t = textOf(el);
      if (/^-?[\d,]+$/.test(t) && t.length >= 2 && el.children.length === 0) {
        const parentText = el.parentElement?.parentElement?.textContent?.toLowerCase() ?? "";
        if (parentText.includes("available") && data.availablePoints == null) {
          data.availablePoints = parseIntSafe(t);
        } else if (parentText.includes("pending") && data.pendingPoints == null) {
          data.pendingPoints = parseIntSafe(t);
        }
      }
    }
  }

  return data;
}

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "chase");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  const url = window.location.href.toLowerCase();

  // Service worker handles multi-card iteration via getChaseAccountLinks + chaseMultiCardFlow
  if (url.includes("/account-selector")) {
    await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: "logged_in" });
    return;
  }

  updateOverlay("extracting", "chase");
  updateOverlayProgress("Finding your Chase cards...");
  const found = await waitForSelector(".card-details, .points-balance");
  const chaseCardEl = document.querySelector(".card-details .mds-body-large-heavier");
  if (chaseCardEl) {
    updateOverlayProgress(`Syncing ${chaseCardEl.textContent?.trim().replace(/®/g, "")}...`);
  } else {
    updateOverlayProgress("Reading points and rewards...");
  }

  // Extra settle time — Chase renders points asynchronously after the container appears
  await runControl.sleep(4000, attemptId);

  runControl.throwIfCancelled(attemptId);
  updateOverlayProgress("Finishing up...");
  const data = scrapeDashboard();
  await runControl.sendMessage(attemptId, { type: "CHASE_DASHBOARD_DONE", data });
}

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
  if (message.type === "UPDATE_OVERLAY_PROGRESS") {
    updateOverlay("extracting", "chase");
    updateOverlayProgress(message.message);
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "GET_LOGIN_STATE") {
    sendResponse({ state: monitor.getState() });
  }
  return true;
});

let syncActive = false;
const monitor = createLoginStateMonitor({
  provider: "chase",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "chase");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "chase");
    } else {
      updateOverlay("waiting_for_login", "chase");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "chase" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "chase");
    if (typeof r?.progressMessage === "string") {
      updateOverlayProgress(r.progressMessage);
    } else {
      const cardNameEl = document.querySelector(".card-details .mds-body-large-heavier");
      if (cardNameEl) {
        updateOverlayProgress(`Syncing ${cardNameEl.textContent?.trim().replace(/®/g, "")}...`);
      }
    }
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "chase");
  }
});
