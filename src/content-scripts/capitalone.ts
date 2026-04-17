/**
 * Content script for myaccounts.capitalone.com (runs in ISOLATED WORLD).
 *
 * Scrapes the account summary and rewards pages:
 *   - Card names + last digits from account tiles
 *   - Shared rewards balance from the rewards tile
 *   - Benefit names from the rewards/benefits page (descriptive only — no usage tracking)
 *
 * Capital One has a shared rewards balance across cards, so we report
 * that balance once on the primary card instead of duplicating it everywhere.
 */

import type { LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";
import {
  isLikelyCapitalOneCardTile,
  parseCapitalOneRewardsSummary,
  selectCapitalOneCardName,
} from "./capitalone-parsing";

const runControl = createContentScriptRunControl("capitalone");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  if (
    url.includes("myaccounts.capitalone.com/accountsummary") ||
    url.includes("myaccounts.capitalone.com/card/") ||
    url.includes("myaccounts.capitalone.com/rewards")
  ) {
    return "logged_in";
  }

  if (
    url.includes("verified.capitalone.com") ||
    url.includes("capitalone.com/identity-management")
  ) {
    return "logged_out";
  }

  return "unknown";
}

// ── Wait for content to render ───────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────

function parseIntSafe(str: string): number | null {
  const n = parseInt(str.replace(/[,\s$]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

// ── Scrape account summary page ──────────────────────────────

interface CardInfo {
  name: string;
  lastDigits: string;
}

function scrapeAccountSummary() {
  const data = {
    cards: [] as CardInfo[],
    totalRewards: null as number | null,
    rewardsLabel: null as string | null,
  };

  // Card tiles: <c1-ease-account-tile> → .account-tile
  // Capital One mixes cards and deposit accounts on the summary page, so we
  // only keep tiles that look like branded credit-card products.
  const tiles = document.querySelectorAll("c1-ease-account-tile, .account-tile");
  const seen = new Set<string>();

  for (const tile of tiles) {
    const numberEl = tile.querySelector(".primary-detail__identity__account-number");
    const lastDigits = numberEl ? textOf(numberEl).replace(/[^0-9]/g, "") : "";

    if (!lastDigits || seen.has(lastDigits)) continue;

    const primaryEl = tile.querySelector("c1-ease-main-primary-content, .account-tile__main__primary");
    const brandingImg = tile.querySelector(".primary-detail__identity__img");
    const backgroundImage = tile instanceof HTMLElement ? tile.style.backgroundImage : "";
    const name = selectCapitalOneCardName({
      imageAlt: brandingImg?.getAttribute("alt"),
      headingText: textOf(tile.querySelector(".primary-detail__identity-header [role='heading'], .primary-detail__identity-header span")),
      identityText: textOf(tile.querySelector(".primary-detail__identity")),
      primaryText: primaryEl ? textOf(primaryEl) : "",
      tileText: textOf(tile),
    });

    if (
      !isLikelyCapitalOneCardTile({
        imageSrc: brandingImg?.getAttribute("src"),
        backgroundImage,
        cardName: name,
        primaryText: primaryEl ? textOf(primaryEl) : "",
        tileText: textOf(tile),
        lastDigits,
      })
    ) {
      continue;
    }

    seen.add(lastDigits);

    // Capital One often renders the product name as image alt text, not
    // visible text, so we prefer explicit branding nodes over regex parsing.
    if (name) {
      data.cards.push({ name, lastDigits });
    }
  }

  // The rewards tile can represent miles or cashback, and cashback balances
  // split dollars/cents across separate nodes.
  const loyaltyTile = document.querySelector("c1-ease-rewards-tile-container, .loyalty-tile");
  if (loyaltyTile) {
    const rewardsSummary = parseCapitalOneRewardsSummary({
      balanceText: textOf(loyaltyTile.querySelector(".primary-detail__balance")),
      dollarText: textOf(loyaltyTile.querySelector(".primary-detail__balance-dollar")),
      centText: Array.from(loyaltyTile.querySelectorAll(".primary-detail__balance-superscript"))
        .map((el) => textOf(el))
        .filter((text) => /\d/.test(text))
        .at(-1) ?? "",
      labelText: textOf(loyaltyTile.querySelector(".labels__balance")),
    });

    data.totalRewards = rewardsSummary.amount;
    data.rewardsLabel = rewardsSummary.rewardsLabel;
  }

  return data;
}

// ── Scrape benefits from rewards/benefits page ───────────────

function scrapeBenefits() {
  const benefits: { name: string; amountUsed: number | null; totalAmount: number | null; remaining: number | null; period: string | null }[] = [];

  // Benefit tiles: .c1-cc-rewards-benefit-tile with __title and __subtitle
  const tiles = document.querySelectorAll(".c1-cc-rewards-benefit-tile");
  const seen = new Set<string>();

  for (const tile of tiles) {
    const titleEl = tile.querySelector(".c1-cc-rewards-benefit-tile__title");
    const subtitleEl = tile.querySelector(".c1-cc-rewards-benefit-tile__subtitle");
    const name = titleEl ? textOf(titleEl) : "";
    const subtitle = subtitleEl ? textOf(subtitleEl) : "";

    if (!name || seen.has(name)) continue;
    seen.add(name);

    const dollarMatch = subtitle.match(/\$[\d,]+/);
    const totalAmount = dollarMatch ? parseIntSafe(dollarMatch[0]) : null;

    benefits.push({
      name,
      amountUsed: null, // Capital One doesn't expose usage on this page
      totalAmount,
      remaining: null,
      period: null,
    });
  }

  return benefits;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "capitalone");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "capitalone");
  updateOverlayProgress("Reading Capital One rewards...");
  const url = window.location.href.toLowerCase();

  if (url.includes("/rewards/benefits")) {
    await waitForSelector(".c1-cc-rewards-benefit-tile");
    await runControl.sleep(2000, attemptId);

    runControl.throwIfCancelled(attemptId);
    const benefits = scrapeBenefits();
    await runControl.sendMessage(attemptId, {
      type: "CAPITALONE_BENEFITS_DONE",
      benefits,
    });
    return;
  }

  if (url.includes("/rewards")) {
    await waitForSelector(".c1-ease-card-rewards-display__balance, .c1-ease-card-rewards-tabs");
    await runControl.sleep(2000, attemptId);

    const cardTextEl = document.querySelector(".c1-ease-rewards-header-container__card-text");
    const balanceEl = document.querySelector(".c1-ease-card-rewards-display__balance");

    const cardText = cardTextEl ? textOf(cardTextEl).replace(/\s*>\s*$/, "") : null;
    const balanceText = balanceEl ? textOf(balanceEl) : "";
    const miles = parseIntSafe(balanceText.replace(/[^0-9,]/g, ""));

    await runControl.sendMessage(attemptId, {
      type: "CAPITALONE_REWARDS_DONE",
      cardName: cardText,
      miles,
    });
    return;
  }

  if (url.includes("accountsummary")) {
    await waitForSelector("c1-ease-account-tile, .account-tile");
    await runControl.sleep(3000, attemptId);

    runControl.throwIfCancelled(attemptId);
    const summaryData = scrapeAccountSummary();
    await runControl.sendMessage(attemptId, {
      type: "EXTRACTION_DONE",
        data: {
          cardName: summaryData.cards[0]
            ? `${summaryData.cards[0].name} (${summaryData.cards[0].lastDigits})`
            : null,
          availablePoints: summaryData.totalRewards,
          pendingPoints: null,
          benefits: [],
          rewardsLabel: summaryData.rewardsLabel,
        },
        cards: summaryData.cards,
        totalRewards: summaryData.totalRewards,
        rewardsLabel: summaryData.rewardsLabel,
    });
    return;
  }

  await runControl.sendMessage(attemptId, {
    type: "EXTRACTION_DONE",
    data: {
      cardName: null,
      availablePoints: null,
      pendingPoints: null,
      benefits: [],
    },
  });
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
  provider: "capitalone",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "capitalone");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "capitalone");
    } else {
      updateOverlay("waiting_for_login", "capitalone");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "capitalone" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "capitalone");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "capitalone");
  }
});
