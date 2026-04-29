/**
 * Content script for global.americanexpress.com (runs in ISOLATED WORLD).
 *
 * Scrapes the Membership Rewards dashboard page (/rewards):
 *   - Card name + last digits from the context switcher
 *   - Available points from the overview vitals tile
 *   - Benefit credit trackers (dollar amounts via <progress> elements)
 *   - Card benefits and their enrollment status from the benefits preview
 *
 * Supports multi-card scraping:
 *   - START_EXTRACTION (no cardIndex) → scrape current card, report totalCards
 *   - START_EXTRACTION (cardIndex: N) → click Nth card in switcher, scrape it
 *   - GET_CARD_OPTIONS → return list of available cards from context switcher
 */

import type { LoginState } from "../lib/types";
import { extractLastFourDigits } from "../lib/card-digits";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, updateOverlayProgress, hideOverlay } from "../lib/overlay";
import { createLoginStateMonitor } from "../lib/login-state-monitor";

const runControl = createContentScriptRunControl("amex");
// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  if (url.includes("global.americanexpress.com/rewards") || url.includes("global.americanexpress.com/dashboard") || url.includes("global.americanexpress.com/card-benefits")) {
    return "logged_in";
  }

  if (url.includes("americanexpress.com/en-us/account/login")) {
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

// ── Context switcher (multi-card) ────────────────────────────

interface CardOption {
  name: string;
  lastDigits: string;
  index: number;
  isCancelled: boolean;
}

async function getCardOptions(): Promise<CardOption[]> {
  const options: CardOption[] = [];
  // Options live in #simple-switcher-listbox (sibling of combobox, not child).
  // The listbox is only rendered when the dropdown is open, so open it first.
  const combobox = document.querySelector('[data-testid="simple_switcher_combobox"]') as HTMLElement;
  if (!combobox) return options;

  const wasOpen = combobox.getAttribute("aria-expanded") === "true";
  if (!wasOpen) {
    combobox.click();
    await new Promise((r) => setTimeout(r, 400));
  }

  const listbox = document.querySelector("#simple-switcher-listbox");
  if (!listbox) {
    if (!wasOpen) combobox.click();
    return options;
  }

  // Only include card product options (skip Overview, savings accounts, etc.)
  const items = listbox.querySelectorAll('[role="option"][data-testid*="product_option_CARD_PRODUCT"]');
  items.forEach((item, index) => {
    const nameEl = item.querySelector('[data-testid="simple_switcher_display_name"]');
    const numberEl = item.querySelector('[data-testid="simple_switcher_display_number_val"]');
    const name = nameEl ? textOf(nameEl) : "";
    const lastDigits = extractLastFourDigits(textOf(numberEl)) ?? "";

    const fullText = textOf(item).toLowerCase();
    const isCancelled = fullText.includes("cancel") || fullText.includes("closed") || fullText.includes("terminated");

    if (name) {
      options.push({ name, lastDigits, index, isCancelled });
    }
  });

  if (!wasOpen) combobox.click();

  return options;
}

async function openSwitcherAndClickCard(cardIndex: number, attemptId: string): Promise<boolean> {
  const trigger = document.querySelector('[data-testid="simple_switcher_combobox"]') as HTMLElement;

  if (!trigger) {
    console.warn("[NextCard Amex] Context switcher trigger not found");
    return false;
  }

  trigger.click();
  await runControl.sleep(400, attemptId);

  // cardIndex refers to position within CARD_PRODUCT options only (same as getCardOptions)
  const options = document.querySelectorAll('#simple-switcher-listbox [role="option"][data-testid*="product_option_CARD_PRODUCT"]');
  if (cardIndex >= options.length) {
    console.warn(`[NextCard Amex] Card index ${cardIndex} out of range (${options.length} card options)`);
    return false;
  }

  const targetOption = options[cardIndex] as HTMLElement;
  targetOption.click();

  await runControl.sleep(2500, attemptId);
  return true;
}

// ── Scrape page — works on both /rewards and /card-benefits/view-all ──

function scrapeAmexPage() {
  const data = {
    cardName: null as string | null,
    availablePoints: null as number | null,
    pendingPoints: null as number | null,
    benefits: [] as { name: string; amountUsed: number | null; totalAmount: number | null; remaining: number | null; period: string | null }[],
  };

  // ── Card name ───────────────────────────────────────────
  const cardNameEl = document.querySelector('[data-testid="simple_switcher_display_name"]');
  const cardNumberEl = document.querySelector('[data-testid="simple_switcher_display_number_val"]');
  if (cardNameEl) {
    const name = textOf(cardNameEl);
    const number = cardNumberEl ? textOf(cardNumberEl).replace(/[^0-9•·.]/g, "") : "";
    data.cardName = number ? `${name} (${number})` : name;
  }

  // ── Points ──────────────────────────────────────────────
  // On /rewards: inside #overview-vitals
  // On /card-benefits: in the header nav as an h4
  const vitals = document.getElementById("overview-vitals");
  if (vitals) {
    const desktopTiles = vitals.querySelectorAll('[data-testid="desktop-tile"]');
    for (const tile of desktopTiles) {
      const label = tile.querySelector('[id^="available-header"]');
      if (label) {
        const valueEl = tile.querySelector(".heading-sans-medium-bold");
        if (valueEl) data.availablePoints = parseIntSafe(textOf(valueEl));
        break;
      }
    }
    if (data.availablePoints == null) {
      const smallTile = vitals.querySelector('[data-testid="small-tile"]');
      const label = smallTile?.querySelector('[id^="available-header"]');
      if (label) {
        const valueEl = smallTile?.querySelector(".heading-sans-medium-bold");
        if (valueEl) data.availablePoints = parseIntSafe(textOf(valueEl));
      }
    }
  }
  // Fallback: points in the nav header (card-benefits page)
  // The h4 contains the number, and a nearby h3 mentions "Points", "Miles", or "Rewards"
  if (data.availablePoints == null) {
    const allH4 = document.querySelectorAll("h4");
    for (const h4 of allH4) {
      const text = textOf(h4).replace(/,/g, "");
      const num = parseInt(text, 10);
      if (!isNaN(num) && num >= 0) {
        const sibling = h4.previousElementSibling;
        const siblingText = sibling ? textOf(sibling).toLowerCase() : "";
        if (siblingText.includes("points") || siblingText.includes("miles") || siblingText.includes("rewards")) {
          data.availablePoints = num;
          break;
        }
      }
    }
  }

  // ── Benefit credit trackers ─────────────────────────────
  // We support two DOM structures:
  //   /rewards page: data-testid="tracker-component" with <progress> elements
  //   /card-benefits page: group elements with [role="progressbar"] and text like "$59 earned"
  // Deduplicates by name, preferring versions with progress data.

  const benefitMap = new Map<string, { amountUsed: number | null; totalAmount: number | null; remaining: number | null; period: string | null }>();

  // Strategy A: tracker-component with <progress> (rewards page)
  const trackerComponents = document.querySelectorAll('[data-testid="tracker-component"]');
  for (const comp of trackerComponents) {
    const heading = comp.querySelector("h3");
    if (!heading) continue;
    const name = textOf(heading);
    if (!name) continue;

    const progress = comp.querySelector("progress");
    if (progress) {
      const amountUsed = parseFloat(progress.getAttribute("value") ?? "");
      const totalAmount = parseFloat(progress.getAttribute("max") ?? "");
      if (!isNaN(totalAmount)) {
        const remaining = !isNaN(amountUsed) ? Math.round((totalAmount - amountUsed) * 100) / 100 : null;
        benefitMap.set(name, { amountUsed: !isNaN(amountUsed) ? amountUsed : null, totalAmount, remaining, period: null });
      }
    } else {
      // No progress bar — could be congratulations/completed, or "Earned this Year" with no bar
      if (benefitMap.has(name)) continue;
      const compText = textOf(comp);
      const compTextLower = compText.toLowerCase();

      // Extract annual total from heading
      const nameDollarMatch = name.match(/\$([\d,]+)/);
      let totalAmount = nameDollarMatch ? parseFloat(nameDollarMatch[1].replace(/,/g, "")) : null;
      let amountUsed: number | null = null;

      // Try info-pill badge (e.g. "Earned this Year: $16.49")
      const earnedBadge = comp.querySelector('[data-testid*="info-pill"]');
      if (earnedBadge) {
        const badgeMatch = textOf(earnedBadge).match(/\$([\d,]+(?:\.\d{2})?)/);
        if (badgeMatch) amountUsed = parseFloat(badgeMatch[1].replace(/,/g, ""));
      }
      // Try "Earned this Year: $X" anywhere in the text
      if (amountUsed == null) {
        const yearMatch = compText.match(/Earned this Year:\s*\$([\d,]+(?:\.\d{2})?)/i);
        if (yearMatch) amountUsed = parseFloat(yearMatch[1].replace(/,/g, ""));
      }
      // Try description testid
      if (amountUsed == null) {
        const descEl = comp.querySelector('[data-testid*="description"]');
        if (descEl) {
          const descMatch = textOf(descEl).match(/\$([\d,]+(?:\.\d{2})?)/);
          if (descMatch) amountUsed = parseFloat(descMatch[1].replace(/,/g, ""));
        }
      }
      // Try "you've received $X" / "you've earned $X" in body text (after heading)
      if (amountUsed == null && (compTextLower.includes("congratulations") || compTextLower.includes("you've earned") || compTextLower.includes("you've received") || compTextLower.includes("fully used"))) {
        const receivedMatch = compText.match(/(?:received|earned|used)\s+\$([\d,]+(?:\.\d{2})?)/i);
        if (receivedMatch) amountUsed = parseFloat(receivedMatch[1].replace(/,/g, ""));
      }

      // If we found any data, add it
      if (totalAmount != null || amountUsed != null) {
        if (amountUsed == null && (compTextLower.includes("congratulations") || compTextLower.includes("fully used"))) {
          amountUsed = totalAmount; // fully used
        }
        const remaining = amountUsed != null && totalAmount != null && !isNaN(amountUsed) && !isNaN(totalAmount)
          ? Math.round((totalAmount - amountUsed) * 100) / 100 : null;
        benefitMap.set(name, {
          amountUsed: amountUsed != null && !isNaN(amountUsed) ? amountUsed : null,
          totalAmount: totalAmount != null && !isNaN(totalAmount) ? totalAmount : null,
          remaining, period: null,
        });
      }
    }
  }

  // Strategy B: group elements with [role="progressbar"] (card-benefits page)
  // These are inside the "Benefits Activity" section
  const groupTrackers = document.querySelectorAll('[data-testid="tracker-component-section"] group, [role="group"]');
  for (const group of groupTrackers) {
    const heading = group.querySelector("h3");
    if (!heading) continue;
    const name = textOf(heading);
    if (!name || benefitMap.has(name)) continue;

    // Look for progressbar ARIA role
    const progressbar = group.querySelector('[role="progressbar"]');
    if (progressbar) {
      const ariaLabel = progressbar.getAttribute("aria-label") ?? "";
      // aria-label like "Progress bar from 0 to 200"
      const rangeMatch = ariaLabel.match(/from\s+([\d.]+)\s+to\s+([\d,.]+)/i);
      let totalAmount: number | null = null;
      let amountUsed: number | null = null;

      if (rangeMatch) {
        totalAmount = parseFloat(rangeMatch[2].replace(/,/g, ""));
      }

      // Parse the text labels like "$59 earned" / "$141 to go"
      const labels = group.querySelectorAll('[role="progressbar"] ~ div div, [role="progressbar"] + div div');
      for (const label of Array.from(labels)) {
        const t = textOf(label).toLowerCase();
        const dollarMatch = t.match(/\$([\d,]+(?:\.\d{2})?)/);
        if (dollarMatch && (t.includes("earned") || t.includes("spent"))) {
          amountUsed = parseFloat(dollarMatch[1].replace(/,/g, ""));
        }
      }

      // Broader fallback: look for any "$X earned/spent" text in the group
      if (amountUsed == null) {
        const groupText = textOf(group);
        const earnedMatch = groupText.match(/\$([\d,]+(?:\.\d{2})?)\s*(?:earned|spent)/i);
        if (earnedMatch) amountUsed = parseFloat(earnedMatch[1].replace(/,/g, ""));
      }

      // Also check "Earned this Year: $X" badge text
      if (amountUsed == null) {
        const groupText = textOf(group);
        const yearMatch = groupText.match(/Earned this (?:Year|year):\s*\$([\d,]+(?:\.\d{2})?)/i);
        if (yearMatch) amountUsed = parseFloat(yearMatch[1].replace(/,/g, ""));
      }

      if (totalAmount != null) {
        const remaining = amountUsed != null ? Math.round((totalAmount - amountUsed) * 100) / 100 : null;
        benefitMap.set(name, {
          amountUsed: amountUsed ?? 0,
          totalAmount,
          remaining,
          period: null,
        });
      }
      continue;
    }

    // No progressbar — might be a congratulations/completed or locked benefit
    const groupText = textOf(group).toLowerCase();
    if (groupText.includes("congratulations") || groupText.includes("you've earned") || groupText.includes("you've received") || groupText.includes("fully used")) {
      const nameDollarMatch = name.match(/\$([\d,]+)/);
      let totalAmount = nameDollarMatch ? parseFloat(nameDollarMatch[1].replace(/,/g, "")) : null;
      let amountUsed: number | null = null;
      const yearMatch = textOf(group).match(/Earned this (?:Year|year):\s*\$([\d,]+(?:\.\d{2})?)/i);
      if (yearMatch) amountUsed = parseFloat(yearMatch[1].replace(/,/g, ""));
      if (amountUsed == null) amountUsed = totalAmount;
      const remaining = amountUsed != null && totalAmount != null
        ? Math.round((totalAmount - amountUsed) * 100) / 100 : null;
      benefitMap.set(name, {
        amountUsed: amountUsed != null && !isNaN(amountUsed) ? amountUsed : null,
        totalAmount: totalAmount != null && !isNaN(totalAmount) ? totalAmount : null,
        remaining, period: null,
      });
    }
  }

  for (const [name, benefit] of benefitMap) {
    data.benefits.push({ name, ...benefit });
  }

  // ── Enrollment-only benefits (no dollar tracker) ─────────
  const benefitsPreview = document.getElementById("axp-benefits-preview");
  if (benefitsPreview) {
    for (const tile of benefitsPreview.querySelectorAll('[data-testid="desktop-tile"], [data-testid="mobile-tile"]')) {
      const headingEl = tile.querySelector("h3");
      if (!headingEl) continue;
      const name = textOf(headingEl);
      if (!name || benefitMap.has(name)) continue;
      benefitMap.set(name, { amountUsed: null, totalAmount: null, remaining: null, period: null });
      const statusEl = tile.querySelector('[data-testid="enroll-status"] [data-status] p');
      data.benefits.push({ name, amountUsed: null, totalAmount: null, remaining: null, period: statusEl ? textOf(statusEl) : null });
    }
  }

  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function waitForContentAndExpand(attemptId: string) {
  runControl.throwIfCancelled(attemptId);

  // Click "Show All" / "Show all available trackers" to expand all trackers
  const showAllBtn = Array.from(document.querySelectorAll("button")).find((b) => {
    const text = b.textContent?.trim().toLowerCase() ?? "";
    return text === "show all" || text.includes("show all available trackers");
  });
  if (showAllBtn) {
    showAllBtn.click();
    await runControl.sleep(1500, attemptId);
  }
}

async function runExtraction(attemptId: string, cardIndex?: number) {
  const loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState === "logged_out" || loginState === "mfa_challenge") {
    showOverlay("waiting_for_login", "amex");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "amex");
  updateOverlayProgress("Finding your Amex cards...");

  // Wait for page content — supports both /rewards and /card-benefits/view-all.
  // First wait for the card switcher (fast), then wait for benefit trackers to load.
  await waitForSelector('[data-testid="simple_switcher_display_name"]', 10000);
  runControl.throwIfCancelled(attemptId);

  // Show which card we're syncing
  const currentCardName = document.querySelector('[data-testid="simple_switcher_display_name"]');
  const currentCardNum = document.querySelector('[data-testid="simple_switcher_display_number_val"]');
  if (currentCardName) {
    const label = textOf(currentCardName).replace(/®/g, "");
    const num = currentCardNum ? textOf(currentCardNum) : "";
    updateOverlayProgress(`Syncing ${label}${num ? ` ${num}` : ""}...`);
  }

  // Wait for tracker content or timeout (some cards have no trackers)
  await waitForSelector('[data-testid="tracker-component"], [data-testid="tracker-component-section"], [role="progressbar"]', 3000);
  await runControl.sleep(500, attemptId);

  // Check if the current card is cancelled or page is unavailable
  function isCardUnavailable(): boolean {
    const statusEl = document.querySelector('[data-testid="simple_switcher_display_status"]');
    const currentStatus = statusEl ? textOf(statusEl).toLowerCase() : "";
    if (currentStatus.includes("cancel") || currentStatus.includes("closed")) return true;
    const bodyText = document.body.innerText;
    return bodyText.includes("Page Unavailable") || bodyText.includes("has been cancelled")
      || bodyText.includes("isn't eligible") || bodyText.includes("not eligible");
  }

  if (isCardUnavailable() && cardIndex == null) {
    const allOptions = await getCardOptions();
    const firstActive = allOptions.find((c) => !c.isCancelled);
    if (firstActive) {
      const switched = await openSwitcherAndClickCard(firstActive.index, attemptId);
      if (switched) {
        await waitForContentAndExpand(attemptId);
      }
    }
  } else {
    await waitForContentAndExpand(attemptId);
  }

  if (cardIndex != null) {
    updateOverlayProgress("Switching card...");
    const switched = await openSwitcherAndClickCard(cardIndex, attemptId);
    if (!switched) {
      await runControl.sendMessage(attemptId, {
        type: "AMEX_CARD_DONE",
        cardIndex,
        data: null,
        error: "Failed to switch card",
      });
      return;
    }

    // Show which card we switched to
    const switchedCardName = document.querySelector('[data-testid="simple_switcher_display_name"]');
    const switchedCardNum = document.querySelector('[data-testid="simple_switcher_display_number_val"]');
    if (switchedCardName) {
      const label = textOf(switchedCardName).replace(/®/g, "");
      const num = switchedCardNum ? textOf(switchedCardNum) : "";
      updateOverlayProgress(`Syncing ${label}${num ? ` ${num}` : ""}...`);
    }

    await waitForSelector('[data-testid="tracker-component"], [data-testid="tracker-component-section"], [role="progressbar"]', 3000);
    await runControl.sleep(500, attemptId);

    if (isCardUnavailable()) {
      const cardNameEl = document.querySelector('[data-testid="simple_switcher_display_name"]');
      const cardLabel = cardNameEl ? textOf(cardNameEl) : `card index ${cardIndex}`;
      await runControl.sendMessage(attemptId, {
        type: "AMEX_CARD_DONE",
        cardIndex,
        data: null,
        error: "Card not eligible for Membership Rewards",
      });
      return;
    }

    await waitForContentAndExpand(attemptId);
  }

  runControl.throwIfCancelled(attemptId);
  const scraped = scrapeAmexPage();

  const cardOptions = await getCardOptions();
  const activeCards = cardOptions.filter((c) => !c.isCancelled);

  if (cardIndex != null) {
    await runControl.sendMessage(attemptId, {
      type: "AMEX_CARD_DONE",
      cardIndex,
      data: scraped,
    });
  } else {
    await runControl.sendMessage(attemptId, {
      type: "EXTRACTION_DONE",
      data: scraped,
      totalCards: activeCards.length,
      cardOptions: activeCards.map((c) => ({ name: c.name, lastDigits: c.lastDigits, index: c.index })),
    });
  }
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
    runExtraction(message.attemptId, message.cardIndex);
    sendResponse({ ok: true });
  }
  if (message.type === "GET_LOGIN_STATE") {
    sendResponse({ state: monitor.getState() });
  }
  if (message.type === "GET_CARD_OPTIONS") {
    getCardOptions().then((options) => {
      sendResponse({ options: options.filter((c) => !c.isCancelled) });
    });
    return true; // keep channel open for async response
  }
  if (message.type === "UPDATE_OVERLAY_PROGRESS") {
    updateOverlayProgress(message.message);
    sendResponse({ ok: true });
    return true;
  }
  if (message.type === "AMEX_ALL_DONE") {
    hideOverlay();
    sendResponse({ ok: true });
  }
  return true;
});

let syncActive = false;
const monitor = createLoginStateMonitor({
  provider: "amex",
  detectLoginState,
  onStateChange(newState) {
    if (!syncActive) return;
    if (newState === "logged_in") {
      updateOverlay("extracting", "amex");
    } else if (newState === "mfa_challenge") {
      updateOverlay("mfa_challenge", "amex");
    } else {
      updateOverlay("waiting_for_login", "amex");
    }
  },
});
monitor.start();
const initialState = monitor.getState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "amex" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    syncActive = true;
    showOverlay("extracting", "amex");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    syncActive = true;
    showOverlay("waiting_for_login", "amex");
  }
});
