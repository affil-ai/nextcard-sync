/**
 * Content script for southwest.com (Southwest Rapid Rewards).
 * Runs in ISOLATED WORLD.
 */

import type { SouthwestLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress, stopOverlayPoll } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("southwest");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();
  const pageText = getPageText();
  const hasVisibleAuthModal = hasVisibleLoginModal();
  const hasVisibleTopLoginCta = hasVisibleLoginCta();
  const hasVisibleLoginForm = Array.from(document.querySelectorAll("input")).some((element) => {
    if (!isVisible(element)) return false;
    const input = element as HTMLInputElement;
    const descriptor = `${input.type} ${input.name} ${input.id} ${input.placeholder} ${input.autocomplete}`.toLowerCase();
    return descriptor.includes("password") || descriptor.includes("username") || descriptor.includes("account");
  });
  const hasGreeting = /Hi,\s*[A-Z]/i.test(pageText);
  const hasMemberNumber = /\bRR#\s*\d{6,}/i.test(pageText) || /Rapid Rewards number[\s#]*\d/i.test(pageText);
  const hasAccountMetrics = /available points/i.test(pageText) || /a-list progress/i.test(pageText);

  // If we see a real greeting + account data, the user is logged in — this wins over
  // any visible login CTAs that might appear in the nav or promotional banners.
  if ((hasGreeting || hasMemberNumber) && hasAccountMetrics) return "logged_in";

  // The visible auth modal should win over account scaffolding rendered behind it.
  if (hasVisibleAuthModal || hasVisibleLoginForm || hasVisibleTopLoginCta) return "logged_out";

  // Southwest keeps auth on the same domain, so URL-only detection is too weak on its own.
  if ((url.includes("/login") || url.includes("/account/login")) && !(hasGreeting || hasMemberNumber)) {
    return "logged_out";
  }

  return "unknown";
}

// ── Wait for content to render ───────────────────────────────

function waitForAccountContent(maxWaitMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    if (hasRenderableAccountData()) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, maxWaitMs);

    const observer = new MutationObserver(() => {
      if (!hasRenderableAccountData()) return;

      observer.disconnect();
      clearTimeout(timeout);
      resolve(true);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ── Helpers ──────────────────────────────────────────────────

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() ?? "";
}

function isVisible(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.offsetParent !== null) return true;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().height > 0;
}

function getPageText() {
  return document.body.innerText.replace(/\u00a0/g, " ").replace(/\r/g, "");
}

function hasVisibleLoginModal() {
  return Array.from(document.querySelectorAll('div, section, dialog, [role="dialog"]')).some((element) => {
    if (!isVisible(element)) return false;

    const text = normalizeText(element.textContent);
    if (!text) return false;

    // Southwest's logged-out account page keeps background account content mounted, so
    // we only treat the modal as auth UI when it contains login-form copy.
    return /log in/i.test(text) && /account number or username/i.test(text);
  });
}

function hasVisibleLoginCta() {
  return Array.from(document.querySelectorAll("button, a")).some((element) => {
    if (!isVisible(element)) return false;

    const text = normalizeText(element.textContent).toLowerCase();
    return text === "log in" || text === "sign in";
  });
}

function getSectionText(sectionHeading: string, nextHeadings: string[]) {
  const pageText = getPageText();
  const lowerPageText = pageText.toLowerCase();
  const startIndex = lowerPageText.indexOf(sectionHeading.toLowerCase());
  if (startIndex === -1) return "";

  const sectionStart = startIndex + sectionHeading.length;
  const trailingText = pageText.slice(sectionStart);
  const lowerTrailingText = lowerPageText.slice(sectionStart);

  let endIndex = trailingText.length;
  for (const nextHeading of nextHeadings) {
    const candidateIndex = lowerTrailingText.indexOf(nextHeading.toLowerCase());
    if (candidateIndex !== -1 && candidateIndex < endIndex) {
      endIndex = candidateIndex;
    }
  }

  return trailingText.slice(0, endIndex).trim();
}

function parseIntSafe(value: string | null | undefined) {
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return null;

  const parsed = parseInt(digits, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatCurrency(value: string | null | undefined) {
  if (!value) return null;
  const amount = Number.parseFloat(value.replace(/[^0-9.]/g, ""));
  if (Number.isNaN(amount)) return null;
  return `$${amount.toFixed(2)}`;
}

function extractProgress(sectionHeading: string) {
  const sectionText = getSectionText(sectionHeading, ["Companion Pass progress", "View all account details"]);
  const flightsMatch = sectionText.match(/([\d,]+)\s+out of\s+([\d,]+)\s+flights/i);
  const pointsMatch = sectionText.match(/([\d,]+)\s+out of\s+([\d,]+)\s+points/i);

  return {
    flights: flightsMatch ? parseIntSafe(flightsMatch[1]) : null,
    flightsTarget: flightsMatch ? parseIntSafe(flightsMatch[2]) : null,
    points: pointsMatch ? parseIntSafe(pointsMatch[1]) : null,
    pointsTarget: pointsMatch ? parseIntSafe(pointsMatch[2]) : null,
  };
}

function extractMemberName() {
  const greetingMatch = getPageText().match(/\bHi,\s*([^\n]+)/i);
  return greetingMatch ? normalizeText(greetingMatch[1]) : null;
}

function extractEliteStatus(pageText: string) {
  // Only trust explicit status labels so the "A-List progress" heading does not masquerade as status.
  const preferredMatch = pageText.match(/(?:current status|your status|status level)[^A-Z\n]*(A-List Preferred)/i);
  if (preferredMatch) return "A-List Preferred";

  const aListMatch = pageText.match(/(?:current status|your status|status level)[^A-Z\n]*(A-List)\b/i);
  if (aListMatch) return "A-List";

  return /rapid rewards member since/i.test(pageText) ? "Member" : null;
}

function hasRenderableAccountData() {
  if (hasVisibleLoginModal() || hasVisibleLoginCta()) return false;

  const pageText = getPageText();
  const hasGreeting = /Hi,\s*[A-Z]/i.test(pageText);
  const hasMemberNumber = /\bRR#\s*\d{6,}/i.test(pageText) || /Rapid Rewards number[\s#]*\d/i.test(pageText);
  return (hasGreeting || hasMemberNumber) && /available points/i.test(pageText);
}

function hasAuthenticatedData(data: SouthwestLoyaltyData) {
  // Southwest renders some account scaffolding before auth, so require identity plus at least
  // one concrete account field before we ever mark the sync complete.
  const hasIdentity = !!data.memberName || !!data.memberNumber;
  const hasAccountMetric =
    data.pointsBalance != null ||
    data.availableCreditsDollars != null ||
    data.aListFlights != null ||
    data.aListPoints != null ||
    data.companionFlights != null ||
    data.companionPoints != null;

  return hasIdentity && hasAccountMetric;
}

// ── Scrape account page ─────────────────────────────────────

function scrapeAccountPage(): SouthwestLoyaltyData {
  const pageText = getPageText();
  const availableCreditsSection = getSectionText("Available Credits", ["Available Points", "My Flight Credits"]);
  const availablePointsSection = getSectionText("Available Points", ["My Flight Credits", "A-List progress"]);
  const flightCreditsSection = getSectionText("My Flight Credits", ["A-List progress", "Companion Pass progress"]);
  const aListProgress = extractProgress("A-List progress");
  const companionProgress = extractProgress("Companion Pass progress");
  const creditsMatches = availableCreditsSection.match(/\$?\d[\d,]*(?:\.\d{2})?/g) ?? [];

  const data: SouthwestLoyaltyData = {
    pointsBalance: null,
    eliteStatus: extractEliteStatus(pageText),
    memberName: extractMemberName(),
    memberNumber: null,
    memberSince: null,
    availableCreditsDollars: creditsMatches.length > 0 ? formatCurrency(creditsMatches[creditsMatches.length - 1]) : null,
    flightCreditsSummary: null,
    aListFlights: aListProgress.flights,
    aListFlightsTarget: aListProgress.flightsTarget,
    aListPoints: aListProgress.points,
    aListPointsTarget: aListProgress.pointsTarget,
    companionFlights: companionProgress.flights,
    companionFlightsTarget: companionProgress.flightsTarget,
    companionPoints: companionProgress.points,
    companionPointsTarget: companionProgress.pointsTarget,
  };

  try {
    const memberNumberMatch = pageText.match(/\bRR#\s*([0-9]{6,})/i) ?? pageText.match(/Rapid Rewards number[\s#]*([0-9 ]{6,})/i);
    if (memberNumberMatch) {
      data.memberNumber = memberNumberMatch[1].replace(/\s+/g, "");
    }
  } catch (error) {
    console.warn("[NextCard Southwest] Failed to read member number:", error);
  }

  try {
    const memberSinceMatch = pageText.match(/Rapid Rewards Member since\s+([^\n]+)/i);
    if (memberSinceMatch) {
      data.memberSince = normalizeText(memberSinceMatch[1]);
    }
  } catch (error) {
    console.warn("[NextCard Southwest] Failed to read member since:", error);
  }

  try {
    const pointsMatch = availablePointsSection.match(/([\d,]+)\s+Points/i);
    if (pointsMatch) {
      data.pointsBalance = parseIntSafe(pointsMatch[1]);
    }
  } catch (error) {
    console.warn("[NextCard Southwest] Failed to read points balance:", error);
  }

  try {
    // Southwest currently renders a human-readable sentence when there are no flight credits.
    const summary = normalizeText(flightCreditsSection);
    data.flightCreditsSummary = summary || null;
  } catch (error) {
    console.warn("[NextCard Southwest] Failed to read flight credits:", error);
  }

  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  // Southwest authenticates in-place — same URL, no navigation. The login form
  // appears as a modal overlay and disappears after auth. We handle the entire
  // login-wait + extraction loop here in the content script instead of relying
  // on the service worker's generic login flow (which expects URL changes).

  let loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "southwest");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });

    // Poll until login completes (up to 2 minutes)
    for (let i = 0; i < 120; i++) {
      await runControl.sleep(1000, attemptId);
      loginState = detectLoginState();
      if (loginState === "logged_in") break;
    }

    if (loginState !== "logged_in") return;
    // Stop the overlay poll — we're driving the overlay from here
    stopOverlayPoll();
    await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: "logged_in" });
  }

  updateOverlay("extracting", "southwest");
  updateOverlayProgress("Reading points and A-List progress...");
  await waitForAccountContent(20000);
  await runControl.sleep(2000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const data = scrapeAccountPage();

  if (!hasAuthenticatedData(data)) {
    console.warn("[NextCard Southwest] No authenticated data found after extraction");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "error",
      data: null,
      error: "Could not read account data. Please try again.",
    });
    return;
  }

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
  provider: "southwest",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "southwest");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "southwest");
    } else {
      updateOverlay("waiting_for_login", "southwest");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "southwest" }, (response) => {
  const status = response?.status;
  if (status === "extracting" || (status === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "southwest");
  } else if ((status === "waiting_for_login" || status === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "southwest");
  }
});
