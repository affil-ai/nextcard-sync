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
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("citi");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();
  const bodyText = document.body?.innerText ?? "";

  // Login page
  if (url.includes("citi.com/login") || url.includes("/logon") || url.includes("/signin")) {
    return "logged_out";
  }

  const hasDashboardContent =
    /Good\s+(Morning|Afternoon|Evening)|Account Overview|Credit Cards|Recent Transactions|Sign Off/i.test(bodyText)
    || Boolean(document.getElementById("dashboardWelcomeHeader"))
    || document.querySelector('[aria-label^="Account ending"]') != null;

  // Citi can land on the dashboard route before the app has hydrated. Wait for
  // account content before treating the page as authenticated.
  if (url.includes("online.citi.com/us/ag/dashboard") && hasDashboardContent) {
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

function waitForDashboardReady(maxWaitMs = 25000): Promise<boolean> {
  return new Promise((resolve) => {
    const isReady = () => {
      const bodyText = document.body?.innerText ?? "";
      return /Good\s+(Morning|Afternoon|Evening)|Account Overview|Credit Cards|Recent Transactions|Total ThankYou/i.test(bodyText)
        || document.querySelector("dashboard-account-selector-tile") != null
        || document.querySelector('[id^="cardAccountSelector"][id$="TileBody"]') != null
        || document.querySelector(".reward-wrapper") != null
        || document.querySelector('[aria-label^="Account ending"]') != null
        || document.getElementById("dashboardWelcomeHeader") != null;
    };

    if (isReady()) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, maxWaitMs);

    const observer = new MutationObserver(() => {
      if (!isReady()) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(true);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────

function parseIntSafe(str: string): number | null {
  const n = parseInt(str.replace(/[,\s]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

function getBodyLines() {
  return (document.body?.innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function findLineIndex(lines: string[], pattern: RegExp, startIndex = 0) {
  for (let i = Math.max(0, startIndex); i < lines.length; i += 1) {
    if (pattern.test(lines[i])) return i;
  }
  return -1;
}

function dedupeCards(cards: CitiLoyaltyData["cards"]) {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.cardName ?? ""}::${card.lastFourDigits ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scrapeCardsFromText(lines: string[]) {
  const cards: CitiLoyaltyData["cards"] = [];
  const startIndex = findLineIndex(lines, /^Credit Cards$/i);
  if (startIndex === -1) return cards;

  const endCandidates = [
    findLineIndex(lines, /^Recent Transactions$/i, startIndex + 1),
    findLineIndex(lines, /^FICO/i, startIndex + 1),
    findLineIndex(lines, /^Total ThankYou/i, startIndex + 1),
  ].filter((index) => index > startIndex);
  const endIndex = endCandidates.length > 0 ? Math.min(...endCandidates) : lines.length;
  const sectionLines = lines.slice(startIndex + 1, endIndex);

  for (let i = 1; i < sectionLines.length; i += 1) {
    const lastFourMatch = sectionLines[i].match(/^[-–—]\s*(\d{4})$/);
    if (!lastFourMatch) continue;

    const cardName = sectionLines[i - 1];
    if (!cardName || /current balance|available credit|make a payment/i.test(cardName)) {
      continue;
    }

    cards.push({
      cardName,
      lastFourDigits: lastFourMatch[1],
      rewardsBalance: null,
      rewardsLabel: null,
    });
  }

  return dedupeCards(cards);
}

function inferRewardsLabel(text: string) {
  if (/ThankYou/i.test(text)) return "ThankYou Points";
  if (/Business\s+Miles/i.test(text)) return "Business Miles";
  if (/Miles/i.test(text)) return "Miles";
  return null;
}

function attachRewardsFromText(cards: CitiLoyaltyData["cards"], lines: string[]) {
  for (let i = 0; i < lines.length; i += 1) {
    const cardMatch = lines[i].match(/for card ending in\s+(\d{4})/i);
    if (!cardMatch) continue;

    const lastFourDigits = cardMatch[1];
    const nearbyBefore = lines.slice(Math.max(0, i - 5), i).reverse();
    const nearbyAfter = lines.slice(i + 1, i + 8);
    const label =
      nearbyBefore.map(inferRewardsLabel).find((value) => value != null)
      ?? nearbyAfter.map(inferRewardsLabel).find((value) => value != null)
      ?? null;
    const balance =
      nearbyAfter
        .map((line) => line.match(/^([\d,]+)$/)?.[1] ?? null)
        .find((value) => value != null)
      ?? nearbyBefore
        .map((line) => line.match(/^([\d,]+)$/)?.[1] ?? null)
        .find((value) => value != null)
      ?? null;

    let card = cards.find((candidate) => candidate.lastFourDigits === lastFourDigits);
    if (!card) {
      card = {
        cardName: null,
        lastFourDigits,
        rewardsBalance: null,
        rewardsLabel: null,
      };
      cards.push(card);
    }

    card.rewardsBalance = balance ? parseIntSafe(balance) : card.rewardsBalance;
    card.rewardsLabel = label ?? card.rewardsLabel;
  }
}

// ── Scrape dashboard ────────────────────────────────────────

function scrapeDashboard(): CitiLoyaltyData {
  const cards: CitiLoyaltyData["cards"] = [];

  // Citi has used both a custom tile element and plain buttons with stable
  // cardAccountSelector IDs for the same dashboard card selector UI.
  const tiles = document.querySelectorAll(
    'dashboard-account-selector-tile, [id^="cardAccountSelector"][id$="TileBody"]',
  );

  for (const tile of tiles) {
    const nameEl = tile.querySelector("h3.account-name");
    const cardName = nameEl?.textContent?.trim() ?? null;

    // Last 4 from aria-label "Account ending in XXXX", or the visible
    // account suffix line in the current Citi dashboard.
    const endingEl = tile.querySelector('[aria-label^="Account ending"]');
    const ariaLabel = endingEl?.getAttribute("aria-label") ?? "";
    const lastFourMatch =
      ariaLabel.match(/(\d{4})$/)
      ?? (tile.textContent ?? "").match(/[–—-]\s*(\d{4})\b/);
    const lastFourDigits = lastFourMatch ? lastFourMatch[1] : null;

    if (!cardName && !lastFourDigits) continue;

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

    // Current Citi rewards use a span.reward-amount; older layouts wrapped the
    // actual value in a child span.
    const amountEl = wrapper.querySelector(".reward-amount");
    const valueText =
      amountEl?.querySelector("span:first-child")?.textContent?.trim()
      ?? amountEl?.textContent?.trim()
      ?? "";
    const rewardsBalance = valueText ? parseIntSafe(valueText) : null;

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

  const textCards = scrapeCardsFromText(getBodyLines());
  for (const textCard of textCards) {
    if (
      textCard.lastFourDigits
      && cards.some((card) => card.lastFourDigits === textCard.lastFourDigits)
    ) {
      continue;
    }
    cards.push(textCard);
  }

  attachRewardsFromText(cards, getBodyLines());

  return { cards: dedupeCards(cards) };
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  let loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "citi");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  if (loginState === "unknown") {
    await waitForDashboardReady(25000);
    loginState = detectLoginState();
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
  }

  updateOverlay("extracting", "citi");
  updateOverlayProgress("Finding your Citi cards...");
  await waitForDashboardReady(25000);
  await runControl.sleep(3000, attemptId);
  const citiCardName =
    document.querySelector("dashboard-account-selector-tile h3.account-name")?.textContent?.trim()
    ?? scrapeCardsFromText(getBodyLines())[0]?.cardName;
  if (citiCardName) updateOverlayProgress(`Syncing ${citiCardName}...`);

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
    sendResponse({ state: monitor.getState() });
  }
  return true;
});

let syncActive = false;
const monitor = createLoginStateMonitor({
  provider: "citi",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "citi");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "citi");
    } else {
      updateOverlay("waiting_for_login", "citi");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "citi" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "citi");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "citi");
  }
});
