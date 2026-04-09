/**
 * Content script for secure.chase.com benefits page (runs in ISOLATED WORLD).
 *
 * Phase 2 of Chase sync:
 *   - Runs on the benefits hub page (secure.chase.com/…/benefits/hub)
 *   - Finds credit-type benefits (those with dollar values in "Maximize your credits" section)
 *   - Clicks each one to open the detail page
 *   - Scrapes $used/$total progress and "Good through" period
 *   - Navigates back to hub and repeats
 *   - Reports all via CHASE_BENEFITS_DONE message
 */

import type { ChaseBenefit } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay } from "../lib/overlay";

const runControl = createContentScriptRunControl("chase");
function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

function parseDollar(str: string): number | null {
  const cleaned = str.replace(/[$,]/g, "");
  const n = parseFloat(cleaned);
  return Number.isNaN(n) ? null : n;
}

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

function isBenefitsPage(): boolean {
  return window.location.href.toLowerCase().includes("benefits");
}

function isHubPage(): boolean {
  const url = window.location.href.toLowerCase();
  return url.includes("benefits/hub") || url.includes("card-benefits/landing");
}

function isDetailPage(): boolean {
  return window.location.href.toLowerCase().includes("benefits/detail");
}

interface HubBenefitCard {
  name: string;
  testId: string;
}

interface HubMembershipPerk {
  name: string;
  activationStatus: string | null;
}

function getClickableBenefitCards(): HubBenefitCard[] {
  const cards: HubBenefitCard[] = [];
  const seen = new Set<string>();

  // Find the "Maximize your credits" h2, then get its next sibling .nonFeaturedBenefit div.
  // Structure: .non-featured-benefit-container contains multiple pairs of
  //   h2.non-featured-benefit-title + div.nonFeaturedBenefit as siblings
  let creditsBenefitDiv: Element | null = null;
  for (const h2 of document.querySelectorAll("h2.non-featured-benefit-title")) {
    if (textOf(h2).toLowerCase().includes("maximize your credits")) {
      creditsBenefitDiv = h2.nextElementSibling;
      break;
    }
  }

  if (!creditsBenefitDiv) {
    console.warn("[NextCard Chase Benefits] Could not find 'Maximize your credits' section");
    return [];
  }

  for (const li of creditsBenefitDiv.querySelectorAll<HTMLElement>('li[role="link"][data-testid*="nonFeaturedBenefits-"]')) {
    const testId = li.getAttribute("data-testid") ?? "";

    let name: string | null = null;
    for (const p of li.querySelectorAll("p")) {
      const t = textOf(p);
      if (t.length > 3 && t.length < 120) {
        const lower = t.toLowerCase();
        if (["in use", "activated", "redeemed", "activation required", "locked"].includes(lower)) continue;
        if (/^\$[\d,]+$/.test(t)) continue;
        name = t;
        break;
      }
    }

    if (!name || seen.has(name)) continue;
    seen.add(name);

    cards.push({ name, testId });
  }

  return cards;
}

function getMembershipPerks(): HubMembershipPerk[] {
  const perks: HubMembershipPerk[] = [];
  const seen = new Set<string>();

  let membershipBenefitDiv: Element | null = null;
  for (const h2 of document.querySelectorAll("h2.non-featured-benefit-title")) {
    if (textOf(h2).toLowerCase().includes("enjoy membership perks")) {
      membershipBenefitDiv = h2.nextElementSibling;
      break;
    }
  }

  if (!membershipBenefitDiv) {
    return perks;
  }

  for (const li of membershipBenefitDiv.querySelectorAll<HTMLElement>('li[role="link"][data-testid*="nonFeaturedBenefits-"]')) {
    let name: string | null = null;
    for (const p of li.querySelectorAll("p")) {
      const t = textOf(p);
      if (t.length > 3 && t.length < 120) {
        const lower = t.toLowerCase();
        if (["in use", "activated", "redeemed", "activation required", "locked"].includes(lower)) continue;
        if (/^\$[\d,]+$/.test(t)) continue;
        name = t;
        break;
      }
    }

    if (!name || seen.has(name)) continue;
    seen.add(name);

    const activationStatus = textOf(li.querySelector(".nfli-text-tag"));
    // Membership perks live on the hub page, so we preserve the badge without clicking through.
    perks.push({ name, activationStatus: activationStatus || null });
  }

  return perks;
}

interface BenefitDetailFields {
  amountUsed: number | null;
  totalAmount: number | null;
  remaining: number | null;
  period: string | null;
}

function scrapeBenefitDetail(): BenefitDetailFields | null {
  const detailPage = document.querySelector(".benefits-details-page");
  if (!detailPage) return null;

  const result: BenefitDetailFields = {
    amountUsed: null,
    totalAmount: null,
    remaining: null,
    period: null,
  };

  // Progress format: "$X/$Y" (e.g. "$0/$150", "$120.67/$150")
  // Found in .benefit-status-tile as a <span>
  const statusTile = detailPage.querySelector(".benefit-status-tile");
  const statusText = statusTile?.textContent ?? "";

  const progressMatch = statusText.match(/\$([\d,.]+)\s*\/\s*\$([\d,.]+)/);
  if (progressMatch) {
    result.amountUsed = parseDollar(progressMatch[1]);
    result.totalAmount = parseDollar(progressMatch[2]);
    if (result.amountUsed != null && result.totalAmount != null) {
      result.remaining = Math.max(0, result.totalAmount - result.amountUsed);
      result.remaining = Math.round(result.remaining * 100) / 100;
    }
  }

  const goodThroughMatch = statusText.match(/Good through\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
  if (goodThroughMatch) {
    result.period = `Good through ${goodThroughMatch[1]}`;
  }

  if (result.amountUsed != null || result.totalAmount != null) {
    return result;
  }

  return null;
}

function navigateToHub(): void {
  // SPA hash navigation — replace /detail?... with /hub?account=...
  const url = window.location.href;
  const accountMatch = url.match(/account=(\d+)/);
  if (accountMatch) {
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    const account = params.get("account") ?? accountMatch[1];
    const hubUrl = url.replace(/\/detail\?.*/, `/hub?account=${account}`);
    window.location.href = hubUrl;
  } else {
    window.history.back();
  }
}

async function runBenefitsExtraction(attemptId: string) {
  if (!isBenefitsPage()) {
    console.log("[NextCard Chase Benefits] Not on benefits page, sending empty");
    await runControl.sendMessage(attemptId, { type: "CHASE_BENEFITS_DONE", benefits: [] });
    return;
  }

  console.log("[NextCard Chase Benefits] Starting extraction...");

  if (!isHubPage()) {
    console.log("[NextCard Chase Benefits] Not on hub, current URL:", window.location.href);
    if (isDetailPage()) {
      runControl.throwIfCancelled(attemptId);
      navigateToHub();
      await waitForSelector(".nonFeaturedBenefit");
      await runControl.sleep(2000, attemptId);
    }
  }

  // 3s timeout — cards without credits shouldn't block the whole flow
  await waitForSelector('li[role="link"][data-testid*="nonFeaturedBenefits-"], h2.non-featured-benefit-title', 3000);
  await runControl.sleep(1000, attemptId);

  const cards = getClickableBenefitCards();
  const membershipPerks = getMembershipPerks();
  console.log(`[NextCard Chase Benefits] Found ${cards.length} credit benefits:`, cards.map((c) => c.name));
  console.log(`[NextCard Chase Benefits] Found ${membershipPerks.length} membership perks:`, membershipPerks.map((p) => p.name));

  const benefits: ChaseBenefit[] = membershipPerks.map((perk) => ({
    name: perk.name,
    amountUsed: null,
    totalAmount: null,
    remaining: null,
    period: null,
    activationStatus: perk.activationStatus,
  }));

  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    console.log(`[NextCard Chase Benefits] [${i + 1}/${cards.length}] Clicking: ${card.name}`);

    const li = document.querySelector<HTMLElement>(`li[data-testid="${card.testId}"]`);
    if (!li) {
      console.warn(`[NextCard Chase Benefits] Could not find card element for: ${card.name}`);
      continue;
    }
    runControl.throwIfCancelled(attemptId);
    li.click();

    const detailEl = await waitForSelector(".benefits-details-page", 10000);
    if (!detailEl) {
      console.warn(`[NextCard Chase Benefits] Detail page did not load for: ${card.name}`);
      if (!isHubPage()) navigateToHub();
      await waitForSelector(".nonFeaturedBenefit", 10000);
      await runControl.sleep(1500, attemptId);
      continue;
    }

    await runControl.sleep(1500, attemptId);

    const detail = scrapeBenefitDetail();
    if (detail) {
      benefits.push({
        name: card.name,
        amountUsed: detail.amountUsed,
        totalAmount: detail.totalAmount,
        remaining: detail.remaining,
        period: detail.period,
        activationStatus: null,
      });
      console.log(`[NextCard Chase Benefits] Scraped: ${card.name}`, detail);
    } else {
      console.log(`[NextCard Chase Benefits] No progress data for: ${card.name}`);
    }

    runControl.throwIfCancelled(attemptId);
    navigateToHub();
    await waitForSelector(".nonFeaturedBenefit", 10000);
    await runControl.sleep(2000, attemptId);
  }

  // .tileBenefit tiles show spend-to-unlock progress (e.g. "$1,663/$75,000")
  for (const tile of document.querySelectorAll(".tileBenefit")) {
    const text = textOf(tile);
    const progressMatch = text.match(/\$([\d,]+(?:\.\d{1,2})?)\s*\/\s*\$([\d,]+(?:\.\d{1,2})?)/);
    if (progressMatch) {
      const used = parseDollar(progressMatch[1]);
      const total = parseDollar(progressMatch[2]);
      benefits.push({
        name: "Spend & unlock more benefits",
        amountUsed: used,
        totalAmount: total,
        remaining: used != null && total != null ? Math.round((total - used) * 100) / 100 : null,
        period: null,
      });
    }
  }

  console.log("[NextCard Chase Benefits] All benefits scraped:", benefits);
  await runControl.sendMessage(attemptId, { type: "CHASE_BENEFITS_DONE", benefits });
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
    runBenefitsExtraction(message.attemptId);
    sendResponse({ ok: true });
  }
  return true;
});

chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "chase" }, (response) => {
  const status = response?.status;

  // Benefits pages load during normal browsing too, so only show the overlay
  // when the background worker says an explicit Chase sync is actually active.
  if (status === "waiting_for_login" || status === "detecting_login") {
    showOverlay("waiting_for_login", "chase");
  } else if (status === "extracting") {
    console.log("[NextCard Chase Benefits] Resuming active Chase sync overlay");
    showOverlay("extracting", "chase");
  }
});
