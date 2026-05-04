/**
 * Content script for bilt.com (Bilt Rewards).
 * Runs in ISOLATED WORLD.
 *
 * Two-phase scrape orchestrated by the service worker:
 *   1. Account page (/account) → EXTRACTION_DONE (points, status, name, member #)
 *   2. Status tracker (/account/status-tracker) → BILT_PROGRESS_DONE (tier progress)
 *
 * Bilt uses styled-components with random class names and minimal data-testid
 * attributes, so we rely on text-content matching for most fields.
 */

import type { BiltLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("bilt");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();
  const bodyText = document.body?.innerText ?? "";
  const pointsPill = document.querySelector('[data-testid="user-info-points-pill"]');

  // Wallet is the most reliable authenticated surface for cardholders.
  if (pointsPill || (url.includes("/wallet") && bodyText.includes("Your Wallet"))) {
    return "logged_in";
  }

  if (url.includes("bilt.com/account") && !/sign in|log in/i.test(bodyText)) {
    return "logged_in";
  }

  if (url.includes("login") || url.includes("signin") || url.includes("sign-in")) {
    return "logged_out";
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

function waitForWalletReady(maxWaitMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    const isReady = () => {
      const bodyText = document.body?.innerText ?? "";
      return Boolean(document.querySelector('[data-testid="user-info-points-pill"]'))
        || /Your Wallet|Bilt Cash|\b[\d,.]+\s*[km]?\s*pts?\.?\b/i.test(bodyText);
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

function parseCompactNumber(str: string): number | null {
  const normalized = str.trim().toLowerCase().replace(/pts?\.?$/, "").trim();
  const match = normalized.match(/^([\d,.]+)\s*([km])?$/i);
  if (!match) return parseIntSafe(normalized);

  const base = Number.parseFloat(match[1].replace(/,/g, ""));
  if (Number.isNaN(base)) return null;
  if (match[2] === "k") return Math.round(base * 1_000);
  if (match[2] === "m") return Math.round(base * 1_000_000);
  return Math.round(base);
}

function parseDollarAmount(str: string): number | null {
  const match = str.match(/\$([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const amount = Number.parseFloat(match[1].replace(/,/g, ""));
  return Number.isNaN(amount) ? null : amount;
}

function findLineValueNearLabel(
  lines: string[],
  label: RegExp,
  valuePattern: RegExp,
) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const labelMatch = line.match(label);
    if (!labelMatch) continue;

    const labelIndex = labelMatch.index ?? 0;
    const afterLabel = line.slice(labelIndex + labelMatch[0].length);
    const afterMatch = afterLabel.match(valuePattern);
    if (afterMatch) return afterMatch[1] ?? afterMatch[0];

    const candidates = [
      lines[index + 1] ?? "",
      lines[index - 1] ?? "",
    ];
    for (const candidate of candidates) {
      const match = candidate.match(valuePattern);
      if (match) return match[1] ?? match[0];
    }
  }

  return null;
}

function getBodyLines() {
  return (document.body?.innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupeLinkedCards(cards: Array<{ cardName: string; lastFourDigits: string | null }>) {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${card.cardName}::${card.lastFourDigits ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findLineIndex(lines: string[], pattern: RegExp) {
  return lines.findIndex((line) => pattern.test(line));
}

function parseWalletCredits(lines: string[]) {
  const startIndex = findLineIndex(lines, /^Your Credits$/i);
  if (startIndex === -1) {
    return { availableCreditsCount: null, walletCredits: [] as BiltLoyaltyData["walletCredits"] };
  }

  const endIndexCandidates = [
    findLineIndex(lines, /^Unlock more credits$/i),
    findLineIndex(lines, /^Spend your Bilt Cash$/i),
    findLineIndex(lines, /^How you earn Bilt Cash$/i),
  ].filter((index) => index > startIndex);
  const endIndex = endIndexCandidates.length > 0 ? Math.min(...endIndexCandidates) : lines.length;
  const sectionLines = lines.slice(startIndex + 1, endIndex);

  if (sectionLines.some((line) => /You don.?t have any available credits/i.test(line))) {
    return { availableCreditsCount: 0, walletCredits: [] as BiltLoyaltyData["walletCredits"] };
  }

  const walletCredits: BiltLoyaltyData["walletCredits"] = [];
  for (let i = 0; i < sectionLines.length; i += 1) {
    const line = sectionLines[i];
    if (!/^\$[\d,]+(?:\.\d{1,2})?\s+/.test(line)) continue;

    const expiresAt = sectionLines[i + 1]?.match(/^Expires\s+(.+)$/i)?.[1] ?? null;
    const actionLine = sectionLines[i + (expiresAt ? 2 : 1)] ?? null;
    const actionLabel = actionLine && /^(Use|Redeem|View details)$/i.test(actionLine) ? actionLine : null;
    const amount = parseDollarAmount(line);
    const name = line.replace(/^\$[\d,]+(?:\.\d{1,2})?\s+/, "").trim();

    walletCredits.push({
      name,
      amount,
      expiresAt,
      actionLabel,
    });
  }

  return {
    availableCreditsCount: walletCredits.length,
    walletCredits,
  };
}

async function expandWalletUserMenu() {
  const pill = document.querySelector('[data-testid="user-info-points-pill"]');
  if (!(pill instanceof HTMLElement)) return;

  // The exact balance only appears inside the user menu opened from the points pill.
  pill.click();
  await new Promise((resolve) => setTimeout(resolve, 600));
}

function extractExactPointsFromMenu() {
  const bodyText = document.body?.innerText ?? "";
  const match = bodyText.match(/Your Points\s*\n\s*([\d,]+)/i);
  if (!match) return null;
  return parseIntSafe(match[1]);
}

function extractVisiblePointsBalance(lines: string[]) {
  const exactPointsText = findLineValueNearLabel(
    lines,
    /^your\s+points$/i,
    /^([\d,]+)$/i,
  );
  const exactPoints = exactPointsText ? parseIntSafe(exactPointsText) : null;
  if (exactPoints != null) return exactPoints;

  for (const line of lines) {
    const compactMatch = line.match(/\b([\d,.]+\s*[km]?)\s*pts?\.?\b/i);
    if (compactMatch) {
      const points = parseCompactNumber(compactMatch[1]);
      if (points != null) return points;
    }
  }

  return null;
}

function extractBiltCash(lines: string[], bodyText: string) {
  const balanceText = findLineValueNearLabel(
    lines,
    /bilt\s+cash\s+balance/i,
    /\$[\d,]+(?:\.\d{1,2})?/,
  ) ?? bodyText.match(/Your\s+\d{4}\s+Bilt\s+Cash\s+balance\s*\n\s*(\$[\d,]+(?:\.\d{1,2})?)/i)?.[1]
    ?? bodyText.match(/Bilt\s+Cash\s+balance\s*\n\s*(\$[\d,]+(?:\.\d{1,2})?)/i)?.[1];

  const expiration = findLineValueNearLabel(
    lines,
    /bilt\s+cash\s+balance|spend\s+your\s+bilt\s+cash/i,
    /^Expires\s+(.+)$/i,
  ) ?? bodyText.match(/Bilt\s+Cash\s+balance[\s\S]{0,120}?Expires\s+([^\n]+)/i)?.[1]?.trim()
    ?? null;

  const nextRewardMatch = bodyText.match(
    /(?:You're|You are)\s+([\d,]+)\s+points?\s+away\s+from\s+earning\s+\$([\d,]+(?:\.\d{1,2})?)\s+Bilt\s+Cash/i,
  );

  return {
    balance: balanceText ? parseDollarAmount(balanceText) : null,
    expiration,
    pointsToNextReward: nextRewardMatch ? parseIntSafe(nextRewardMatch[1]) : null,
    nextRewardAmount: nextRewardMatch ? parseDollarAmount(`$${nextRewardMatch[2]}`) : null,
  };
}

function parseWalletLinkedCards(lines: string[]) {
  const cards: Array<{ cardName: string; lastFourDigits: string | null }> = [];

  for (let i = 1; i < lines.length; i += 1) {
    const current = lines[i];
    const previous = lines[i - 1];
    const digitsMatch = current.match(/^•+\s*(\d{4})$/);
    if (!digitsMatch) continue;
    if (!previous || /available|your credits|your wallet/i.test(previous)) continue;

    cards.push({
      cardName: previous,
      lastFourDigits: digitsMatch[1],
    });
  }

  return dedupeLinkedCards(cards);
}

async function scrapeWalletPage() {
  const lines = getBodyLines();
  const bodyText = document.body?.innerText ?? "";
  const pointsPill = document.querySelector('[data-testid="user-info-points-pill"]');
  const linkedCards = parseWalletLinkedCards(lines);
  // Scope credits to the dedicated panel so we don't confuse carousel copy with real wallet credits.
  const { availableCreditsCount, walletCredits } = parseWalletCredits(lines);
  const biltCash = extractBiltCash(lines, bodyText);

  await expandWalletUserMenu();
  const exactPointsBalance = extractExactPointsFromMenu();
  const visiblePointsBalance = extractVisiblePointsBalance(getBodyLines());

  const data: BiltLoyaltyData = {
    pointsBalance:
      exactPointsBalance
      ?? parseCompactNumber(pointsPill?.textContent ?? "")
      ?? visiblePointsBalance,
    eliteStatus: null,
    statusValidThrough: null,
    pointsProgress: null,
    pointsTarget: null,
    spendProgress: null,
    spendTarget: null,
    memberName: null,
    memberNumber: null,
    primaryCardName: linkedCards[0]?.cardName ?? null,
    linkedCardsCount: linkedCards.length || null,
    availableCreditsCount,
    biltCashBalance: biltCash.balance,
    biltCashExpiration: biltCash.expiration,
    pointsToNextBiltCashReward: biltCash.pointsToNextReward,
    nextBiltCashRewardAmount: biltCash.nextRewardAmount,
    walletCredits,
    linkedCards,
  };

  return data;
}

// ── Phase 1: Scrape account page ─────────────────────────────

function scrapeNeighborhoodAccountPage(): BiltLoyaltyData {
  const data: BiltLoyaltyData = {
    pointsBalance: null,
    eliteStatus: null,
    statusValidThrough: null,
    pointsProgress: null,
    pointsTarget: null,
    spendProgress: null,
    spendTarget: null,
    memberName: null,
    memberNumber: null,
    primaryCardName: null,
    linkedCardsCount: null,
    availableCreditsCount: null,
    biltCashBalance: null,
    biltCashExpiration: null,
    pointsToNextBiltCashReward: null,
    nextBiltCashRewardAmount: null,
    walletCredits: [],
    linkedCards: [],
  };

  const allElements = document.querySelectorAll("span, div, a");

  for (const el of allElements) {
    const text = el.textContent?.trim() ?? "";

    // "806 points • #2771126295" pattern
    const pointsNumberMatch = text.match(/^([\d,]+)\s+points?\s*•\s*#(\d+)$/i);
    if (pointsNumberMatch && el.children.length <= 1) {
      data.pointsBalance = parseIntSafe(pointsNumberMatch[1]);
      data.memberNumber = pointsNumberMatch[2];
      continue;
    }

    // Elite status from "Your status" context
    if (/^(Blue|Silver|Gold|Platinum)$/.test(text) && el.children.length === 0) {
      const parentText = el.parentElement?.textContent?.trim() ?? "";
      if (parentText.toLowerCase().includes("your status") && !data.eliteStatus) {
        data.eliteStatus = text;
      }
    }
  }

  // Member name from the Account section "Name" label
  for (const el of document.querySelectorAll("div")) {
    if (el.textContent?.trim() === "Name" && el.children.length === 0) {
      const next = el.nextElementSibling;
      const name = next?.textContent?.trim();
      if (name && name.length > 1 && name.length < 60) {
        data.memberName = name;
        break;
      }
    }
  }

  return data;
}

// ── Phase 2: Scrape status tracker page ─────────────────────

interface BiltProgress {
  eliteStatus: string | null;
  statusValidThrough: string | null;
  pointsProgress: number | null;
  pointsTarget: number | null;
  spendProgress: string | null;
  spendTarget: string | null;
}

function scrapeStatusTracker(): BiltProgress {
  const progress: BiltProgress = {
    eliteStatus: null,
    statusValidThrough: null,
    pointsProgress: null,
    pointsTarget: null,
    spendProgress: null,
    spendTarget: null,
  };

  const bodyText = document.body?.innerText ?? "";

  const statusMatch = bodyText.match(/Elite Status\s*\n\s*(Blue|Silver|Gold|Platinum)\b/i);
  if (statusMatch) {
    progress.eliteStatus = statusMatch[1];
  }

  // "Good through Jan 16, 2028"
  const validMatch = bodyText.match(/Good through\s+([A-Z][a-z]+ \d{1,2},\s*\d{4})/);
  if (validMatch) {
    progress.statusValidThrough = validMatch[1];
  }

  // Progress section: find the container with "Progress to maintain" text
  // It contains two trackers: points (number / number) and spend ($ / $)
  // Structure: "26,019\nPoints\n125,000" and "$6,902\nSpend\n$25,000"
  const progressMatch = bodyText.match(/([\d,]+)\s*\n\s*Points\s*\n\s*([\d,]+)/);
  if (progressMatch) {
    progress.pointsProgress = parseIntSafe(progressMatch[1]);
    progress.pointsTarget = parseIntSafe(progressMatch[2]);
  }

  const spendMatch = bodyText.match(/(\$[\d,]+)\s*\n\s*Spend\s*\n\s*(\$[\d,]+)/);
  if (spendMatch) {
    progress.spendProgress = spendMatch[1];
    progress.spendTarget = spendMatch[2];
  }

  return progress;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  const url = window.location.href.toLowerCase();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "bilt");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "bilt");
  updateOverlayProgress("Reading Bilt wallet and points...");
  if (url.includes("/wallet")) {
    await waitForWalletReady(20000);
  } else {
    await waitForSelector("div", 20000);
  }
  await runControl.sleep(3000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const data = url.includes("/wallet")
    ? await scrapeWalletPage()
    : scrapeNeighborhoodAccountPage();

  // Wallet accounts do not expose full profile info, so require a real balance or wallet payload.
  const hasMeaningfulData =
    data.pointsBalance != null ||
    data.linkedCardsCount != null ||
    data.availableCreditsCount != null ||
    data.biltCashBalance != null ||
    data.memberName != null ||
    data.memberNumber != null;
  if (!hasMeaningfulData) {
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

async function runProgressScrape(attemptId: string) {
  await waitForSelector('[data-testid="user-info-points-pill"]', 10000);
  await runControl.sleep(3000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const progress = scrapeStatusTracker();
  await runControl.sendMessage(attemptId, { type: "BILT_PROGRESS_DONE", progress });
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
  if (message.type === "SCRAPE_PROGRESS") {
    if (typeof message.attemptId !== "string") {
      sendResponse({ ok: false });
      return true;
    }
    runControl.beginAttempt(message.attemptId);
    runProgressScrape(message.attemptId);
    sendResponse({ ok: true });
  }
  if (message.type === "GET_LOGIN_STATE") {
    sendResponse({ state: monitor.getState() });
  }
  return true;
});

let syncActive = false;
const monitor = createLoginStateMonitor({
  provider: "bilt",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "bilt");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "bilt");
    } else {
      updateOverlay("waiting_for_login", "bilt");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "bilt" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "bilt");
    if (typeof r?.progressMessage === "string") updateOverlayProgress(r.progressMessage);
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "bilt");
  }
});
