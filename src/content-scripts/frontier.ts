/**
 * Content script for booking.flyfrontier.com (Frontier Miles).
 * Runs in ISOLATED WORLD.
 */

import type { FrontierLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay } from "../lib/overlay";

const runControl = createContentScriptRunControl("frontier");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();
  const loginContainer = document.querySelector(".login-container.has-gray-background");
  const passwordInput = document.querySelector('input[type="password"]');
  const headerText = getHeaderText();
  const hasAuthenticatedGreeting = /hi,\s*.+\|\s*[\d,]+\s*mi\./i.test(headerText);
  const hasVisibleLogoutButton = Array.from(document.querySelectorAll("button, a")).some((element) => {
    if (!isVisible(element)) return false;
    const text = normalizeText(element.textContent);
    return text === "LOG OUT" || text === "Logout";
  });
  const memberNumber = normalizeText(document.querySelector(".member-number")?.textContent);
  const hasVisibleMemberNumber = /^member\s*#:\s*\d{6,}$/i.test(memberNumber) && isVisible(document.querySelector(".member-number"));

  // A visible login modal always wins. Frontier leaves account-shell markup mounted behind it.
  if (isVisible(loginContainer) || isVisible(passwordInput)) {
    return "logged_out";
  }

  if (hasAuthenticatedGreeting || hasVisibleLogoutButton || hasVisibleMemberNumber) {
    return "logged_in";
  }

  // The profile page is the stable post-login destination, but only after authenticated markers appear.
  if (url.includes("/frontiermiles/profile") && document.querySelector(".user-logged-in")) {
    return "unknown";
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

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function isVisible(element: Element | null) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.offsetParent !== null) return true;

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().height > 0;
}

function parseIntSafe(str: string) {
  const digits = str.replace(/[^\d]/g, "");
  if (!digits) return null;

  const parsed = parseInt(digits, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function getHeaderText() {
  // Frontier hydrates the welcome line in a header widget that is present before profile content loads.
  return normalizeText(document.querySelector(".user-logged-in .user-name")?.textContent);
}

function findTileByLabel(label: string) {
  return Array.from(document.querySelectorAll(".loyalty-tile")).find((tile) => {
    const text = normalizeText(tile.textContent);
    return text.toLowerCase().includes(label.toLowerCase());
  }) ?? null;
}

function extractEliteStatus() {
  const statusTile = findTileByLabel("MY STATUS:");
  const tileHero = normalizeText(statusTile?.querySelector(".tile-hero")?.textContent);
  if (tileHero) return tileHero;

  const bodyText = normalizeText(document.body.innerText);
  const match = bodyText.match(/\b(Member|Elite Silver|Elite Gold|Elite Platinum|Elite Diamond|Silver|Gold|Platinum|Diamond)\b/i);
  return match ? match[1] : null;
}

function extractMemberNumber() {
  const directValue = normalizeText(document.querySelector(".member-number")?.textContent);
  const directMatch = directValue.match(/member\s*#:\s*(\d{6,})/i);
  if (directMatch) return directMatch[1];

  const bodyText = normalizeText(document.body.innerText);
  const match = bodyText.match(/frontier miles\s*#\s*:?\s*(\d{6,})/i);
  return match ? match[1] : null;
}

function extractStatusExpiration(statusTile: Element | null) {
  const text = normalizeText(statusTile?.querySelector(".tile-expiration-text")?.textContent);
  if (!text) return null;

  const match = text.match(/expiration:\s*(.+)$/i);
  return match ? match[1].trim() : text;
}

function extractEliteStatusPoints(statusTile: Element | null) {
  const directValue = normalizeText(
    statusTile?.querySelector(".totalStatus-label span:last-child")?.textContent,
  );
  if (directValue) {
    return parseIntSafe(directValue);
  }

  const statusText = normalizeText(statusTile?.textContent);
  const match = statusText.match(/total elite status points:\s*([\d,]+)/i);
  return match ? parseIntSafe(match[1]) : null;
}

function findStatusBenefitsTile() {
  return Array.from(document.querySelectorAll(".loyalty-tile")).find((tile) => {
    const text = normalizeText(tile.textContent);
    return text.includes("Your Status Tier:") && text.includes("Current Points Balance:");
  }) ?? null;
}

function extractNextEliteStatus(statusBenefitsTile: Element | null) {
  const nextTierContainer = statusBenefitsTile?.querySelector(".benefit-container-highlighted");
  const nextTierName = normalizeText(nextTierContainer?.querySelector(".benefit-title")?.textContent);
  return nextTierName || null;
}

function extractNextEliteStatusTarget(statusBenefitsTile: Element | null) {
  const nextTierContainer = statusBenefitsTile?.querySelector(".benefit-container-highlighted");
  const targetText = normalizeText(nextTierContainer?.querySelector(".benefit-header-amount")?.textContent);
  return targetText ? parseIntSafe(targetText) : null;
}

function extractPointsToNextEliteStatus(statusBenefitsTile: Element | null) {
  const tileText = normalizeText(statusBenefitsTile?.textContent);
  const match = tileText.match(/Only\s+([\d,]+)\s+points\s+to\s+go!/i);
  return match ? parseIntSafe(match[1]) : null;
}

function hasAuthenticatedData(data: FrontierLoyaltyData) {
  // Require at least one member identifier plus one account metric to avoid syncing placeholder shell content.
  const hasIdentity = !!data.memberName || !!data.memberNumber;
  const hasAccountMetric =
    data.milesBalance != null ||
    data.eliteStatusPoints != null ||
    data.pointsToNextEliteStatus != null;

  return hasIdentity && hasAccountMetric;
}

// ── Scrape account page ─────────────────────────────────────

function scrapeAccountPage(): FrontierLoyaltyData {
  const data: FrontierLoyaltyData = {
    milesBalance: null,
    eliteStatus: null,
    eliteStatusPoints: null,
    statusExpiration: null,
    nextEliteStatus: null,
    nextEliteStatusTarget: null,
    pointsToNextEliteStatus: null,
    memberName: null,
    memberNumber: null,
  };

  try {
    const milesTile = findTileByLabel("TRAVEL MILES:");
    const milesText = normalizeText(milesTile?.querySelector(".tile-hero")?.textContent);
    const milesMatch = milesText.match(/([\d,]+)/);
    if (milesMatch) {
      data.milesBalance = parseIntSafe(milesMatch[1]);
    }

    const headerText = getHeaderText();
    const headerNameMatch = headerText.match(/^hi,\s*(.*?)\s*\|/i);
    const headerName = headerNameMatch?.[1]?.trim() ?? "";
    if (headerName) {
      data.memberName = headerName;
    }
  } catch (error) {
    console.warn("[NextCard Frontier] Failed to parse profile header:", error);
  }

  try {
    const nameParts = Array.from(document.querySelectorAll(".member-container .member-name"))
      .map((element) => normalizeText(element.textContent))
      .filter(Boolean);
    if (nameParts.length > 0) {
      // The account tile exposes the full legal name, which is better than the short greeting.
      data.memberName = nameParts.join(" ");
    } else {
      const firstName = normalizeText(document.querySelector(".user-logged-in .first-name")?.textContent);
      if (firstName) {
        data.memberName = firstName;
      }
    }
  } catch (error) {
    console.warn("[NextCard Frontier] Failed to read member name:", error);
  }

  try {
    const statusTile = findTileByLabel("MY STATUS:");
    data.eliteStatus = extractEliteStatus();
    data.statusExpiration = extractStatusExpiration(statusTile);
    data.eliteStatusPoints = extractEliteStatusPoints(statusTile);
  } catch (error) {
    console.warn("[NextCard Frontier] Failed to read elite status:", error);
  }

  try {
    data.memberNumber = extractMemberNumber();
  } catch (error) {
    console.warn("[NextCard Frontier] Failed to read member number:", error);
  }

  try {
    const statusBenefitsTile = findStatusBenefitsTile();
    data.nextEliteStatus = extractNextEliteStatus(statusBenefitsTile);
    data.nextEliteStatusTarget = extractNextEliteStatusTarget(statusBenefitsTile);
    data.pointsToNextEliteStatus = extractPointsToNextEliteStatus(statusBenefitsTile);
  } catch (error) {
    console.warn("[NextCard Frontier] Failed to read next-tier progress:", error);
  }

  console.log("[NextCard Frontier] Scraped data:", data);
  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  console.log("[NextCard Frontier] Login state:", loginState);
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
    showOverlay("waiting_for_login", "frontier");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "frontier");
  console.log("[NextCard Frontier] Waiting for profile content...");
  await waitForSelector(".member-container, .loyalty-tile, .user-logged-in .user-name", 20000);
  // Frontier account tiles hydrate after the shell appears, so give them a short buffer.
  await runControl.sleep(3000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const data = scrapeAccountPage();
  if (!hasAuthenticatedData(data)) {
    console.log("[NextCard Frontier] Scrape looked unauthenticated, waiting for real login");
    showOverlay("waiting_for_login", "frontier");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
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
    sendResponse({ state: detectLoginState() });
  }
  return true;
});

const initialState = detectLoginState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "frontier" }, (response) => {
  const status = response?.status;
  if (status === "extracting" || (status === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "frontier");
  } else if ((status === "waiting_for_login" || status === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "frontier");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "frontier", state: initialState }).catch(() => {});
console.log("[NextCard Frontier] Content script loaded. Login state:", initialState);
