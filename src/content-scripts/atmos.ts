/**
 * Content script for alaskaair.com/atmosrewards (runs in ISOLATED WORLD).
 *
 * Handles two pages:
 *   1. Overview page — member info, points, status
 *   2. Rewards page — lounge passes, wifi passes, etc.
 */

import type { AtmosLoyaltyData, AtmosRewardCard, AtmosDiscount, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("atmos");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  if (url.includes("/login") || url.includes("/signin") || url.includes("auth0.alaskaair.com")) {
    return "logged_out";
  }

  if (url.includes("/atmosrewards/account/") || (url.includes("/atmosrewards/") && !url.includes("/login"))) {
    return "logged_in";
  }

  return "unknown";
}

// ── Wait for content to render ───────────────────────────────

function waitForSelector(selector: string, maxWaitMs = 10000): Promise<Element | null> {
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
  const n = parseInt(str.replace(/,/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}

// ── Scrape overview page ────────────────────────────────────

function scrapeOverviewPage(): Partial<AtmosLoyaltyData> {
  const data: Partial<AtmosLoyaltyData> = {};

  // Member name
  const nameEl = document.querySelector(".member-info .display-md");
  if (nameEl) data.memberName = nameEl.textContent?.trim() ?? null;

  // Status level
  const tierRow = document.querySelector(".member-tier-row");
  if (tierRow) {
    const tierDiv = tierRow.querySelector("div");
    if (tierDiv) data.statusLevel = tierDiv.textContent?.trim() ?? null;
  }

  // Member number
  const numberEl = document.querySelector(".loyalty-number .display-xs");
  if (numberEl) data.memberNumber = numberEl.textContent?.trim() ?? null;

  // Available points (note: Alaska's typo "availible")
  const pointsEl = document.querySelector(".availible-points .display-xs");
  if (pointsEl) data.availablePoints = parseIntSafe(pointsEl.textContent?.trim() ?? "");

  // Status points — multiple approaches
  // 1. span.status-points-info
  const spEl = document.querySelector("span.status-points-info");
  if (spEl) {
    const m = spEl.textContent?.match(/([\d,]+)\s*\//);
    if (m) data.statusPoints = parseIntSafe(m[1]);
  }

  // 2. borealis-progress-bar attribute
  if (data.statusPoints == null) {
    const bar = document.querySelector("borealis-progress-bar[currentpoints]");
    if (bar) data.statusPoints = parseIntSafe(bar.getAttribute("currentpoints") ?? "");
  }

  // 3. data-test-id
  if (data.statusPoints == null) {
    const testEl = document.querySelector("[data-test-id='status-points-info']");
    if (testEl?.parentElement) {
      const m = testEl.parentElement.textContent?.match(/([\d,]+)\s*\//);
      if (m) data.statusPoints = parseIntSafe(m[1]);
    }
  }

  // 4. Shadow DOM walk
  if (data.statusPoints == null) {
    const walkShadows = (root: Document | ShadowRoot): Element | null => {
      const el = root.querySelector("span.status-points-info, [data-test-id='status-points-info']");
      if (el) return el;
      for (const host of root.querySelectorAll("*")) {
        if (host.shadowRoot) {
          const found = walkShadows(host.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    const shadowEl = walkShadows(document);
    if (shadowEl) {
      const m = shadowEl.textContent?.match(/([\d,]+)\s*\//);
      if (m) data.statusPoints = parseIntSafe(m[1]);
    }
  }

  // 5. Broad text search
  if (data.statusPoints == null) {
    for (const el of document.querySelectorAll("span, div, p")) {
      const t = el.textContent?.trim() ?? "";
      if (t.length < 200 && t.includes("milestone") && t.includes("status points")) {
        const m = t.match(/([\d,]+)\s*\//);
        if (m) {
          data.statusPoints = parseIntSafe(m[1]);
          break;
        }
      }
    }
  }

  return data;
}

// ── Scrape rewards page ─────────────────────────────────────

function scrapeRewardsPage(): AtmosRewardCard[] {
  const rewards: AtmosRewardCard[] = [];

  for (const card of document.querySelectorAll(".rewards-card")) {
    const title = card.querySelector(".rewards-card__title")?.textContent?.trim();
    if (!title) continue;

    const associatedCard = card.querySelector(".rewards-card_header-title")?.textContent?.trim() ?? null;

    // Extract "Use by" date from text content
    const textContent = card.querySelector(".rewards-text-content")?.textContent?.trim() ?? "";
    const useByMatch = textContent.match(/Use by:\s*([\d/]+)/i);

    rewards.push({
      title,
      associatedCard,
      useBy: useByMatch?.[1]?.trim() ?? null,
    });
  }

  return rewards;
}

// ── Scrape discounts page ───────────────────────────────────

async function scrapeDiscountsPage(attemptId: string): Promise<AtmosDiscount[]> {
  const discounts: AtmosDiscount[] = [];

  const table = document.querySelector("table.auro_table");
  if (!table) return discounts;

  const rows = table.querySelectorAll("tbody tr");

  for (const row of rows) {
    const cells = row.querySelectorAll("td");
    if (cells.length === 0) continue;

    let expiration: string | null = null;
    let name = "";
    let nameEl: HTMLElement | null = null;
    let code: string | null = null;

    if (cells.length >= 2) {
      // Desktop: two-column layout — cells[0] = expiration, cells[1] = discount name + code
      expiration = cells[0]?.textContent?.trim() ?? null;
      nameEl = cells[1]?.querySelector('auro-hyperlink[role="button"]') as HTMLElement | null;
      name = nameEl?.textContent?.trim() ?? "";
      const cellText = cells[1]?.textContent ?? "";
      const codeMatch = cellText.match(/Code:\s*(\S+)/i);
      code = codeMatch?.[1] ?? null;
    } else {
      // Mobile: single-td responsive layout with label/value pairs
      const td = cells[0];
      nameEl = td?.querySelector('auro-hyperlink[role="button"]') as HTMLElement | null;
      name = nameEl?.textContent?.trim() ?? "";
      const cellText = td?.textContent ?? "";
      const expirationMatch = cellText.match(/Expiration\s*([\d/]+)/i);
      expiration = expirationMatch?.[1]?.trim() ?? null;
      const codeMatch = cellText.match(/Code\s*([A-Z0-9]+)/i);
      code = codeMatch?.[1] ?? null;
    }

    if (!name) continue;

    // Click the hyperlink to open the discount details modal
    let details: string | null = null;
    if (nameEl) {
      runControl.throwIfCancelled(attemptId);
      const shadowBtn = nameEl.shadowRoot?.querySelector("a, button, [role='button']") as HTMLElement | null;
      (shadowBtn ?? nameEl).click();

      // Wait for auro-dialog to open, then wait for its content to load
      const dialog = await waitForOpenDialog(5000);
      if (dialog) {
        // Dialog opens before content loads — poll until we get substantial text
        let content = "";
        for (let i = 0; i < 10; i++) {
          await runControl.sleep(500, attemptId);
          content = dialog.textContent?.trim() ?? "";
          if (!content && dialog.shadowRoot) {
            content = dialog.shadowRoot.textContent?.trim() ?? "";
          }
          // "Discount details" is the title — wait for more than just that
          if (content.length > 30) break;
        }
        if (content.startsWith("Discount details")) {
          content = content.slice("Discount details".length).trim();
        }
        details = content || null;

        closeDialog(dialog);
        await runControl.sleep(500, attemptId);
      }
    }

    discounts.push({ name, code, expiration, details });
  }

  return discounts;
}

function waitForOpenDialog(maxWaitMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const selectors = [
      "auro-dialog[open]",
      "dialog[open]",
      "[role='dialog']:not([aria-hidden='true'])",
      ".modal[style*='display: block']",
      ".modal.show",
    ];
    const check = () => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    };

    const existing = check();
    if (existing) {
      setTimeout(() => resolve(existing), 200);
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, maxWaitMs);

    const observer = new MutationObserver(() => {
      const el = check();
      if (el) {
        observer.disconnect();
        clearTimeout(timeout);
        setTimeout(() => resolve(el), 300);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });
}

function closeDialog(dialog: Element) {
  // Try clicking the close button (× in the top right)
  const closeBtn = dialog.querySelector('[slot="header"] button, button[aria-label="Close"], .close-button') as HTMLElement | null;
  if (closeBtn) {
    closeBtn.click();
    return;
  }
  // Fallback: try shadow DOM close button
  if (dialog.shadowRoot) {
    const shadowClose = dialog.shadowRoot.querySelector('button') as HTMLElement | null;
    if (shadowClose) {
      shadowClose.click();
      return;
    }
  }
  // Last resort: remove the open attribute
  dialog.removeAttribute("open");
}

// ── Orchestration ────────────────────────────────────────────

async function runOverviewExtraction(attemptId: string) {
  let loginState = monitor.getState();
  // Monitor may not have evaluated yet — fall back to direct check
  if (loginState === "unknown") loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "atmos");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "atmos");
  updateOverlayProgress("Reading miles and status...");
  await waitForSelector(".member-info .display-md");
  await runControl.sleep(2000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const data = scrapeOverviewPage();
  await runControl.sendMessage(attemptId, { type: "ATMOS_OVERVIEW_DONE", data });
}

async function runRewardsExtraction(attemptId: string) {
  await waitForSelector(".rewards-card");
  await runControl.sleep(3000, attemptId);

  runControl.throwIfCancelled(attemptId);
  const rewards = scrapeRewardsPage();
  await runControl.sendMessage(attemptId, { type: "ATMOS_REWARDS_DONE", rewards });
}

async function runDiscountsExtraction(attemptId: string) {
  await waitForSelector("table.auro_table");
  await runControl.sleep(3000, attemptId);

  const discounts = await scrapeDiscountsPage(attemptId);
  await runControl.sendMessage(attemptId, { type: "ATMOS_DISCOUNTS_DONE", discounts });
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
    const url = window.location.href.toLowerCase();
    if (url.includes("/account/wallet") || url.includes("section=discounts")) {
      runDiscountsExtraction(message.attemptId);
    } else if (url.includes("/account/rewards")) {
      runRewardsExtraction(message.attemptId);
    } else {
      runOverviewExtraction(message.attemptId);
    }
    sendResponse({ ok: true });
  }
  if (message.type === "GET_LOGIN_STATE") {
    sendResponse({ state: monitor.getState() });
  }
  return true;
});

let syncActive = false;
const monitor = createLoginStateMonitor({
  provider: "atmos",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "atmos");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "atmos");
    } else {
      updateOverlay("waiting_for_login", "atmos");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "atmos" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "atmos");
    if (typeof r?.progressMessage === "string") updateOverlayProgress(r.progressMessage);
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "atmos");
  }
});
