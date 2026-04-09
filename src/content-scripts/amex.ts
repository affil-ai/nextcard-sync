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
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay, hideOverlay } from "../lib/overlay";

const runControl = createContentScriptRunControl("amex");
// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  if (url.includes("global.americanexpress.com/rewards") || url.includes("global.americanexpress.com/dashboard")) {
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
    await new Promise((r) => setTimeout(r, 800));
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
    const lastDigits = numberEl ? textOf(numberEl).replace(/[^0-9]/g, "") : "";

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
  await runControl.sleep(800, attemptId);

  // cardIndex refers to position within CARD_PRODUCT options only (same as getCardOptions)
  const options = document.querySelectorAll('#simple-switcher-listbox [role="option"][data-testid*="product_option_CARD_PRODUCT"]');
  if (cardIndex >= options.length) {
    console.warn(`[NextCard Amex] Card index ${cardIndex} out of range (${options.length} card options)`);
    return false;
  }

  const targetOption = options[cardIndex] as HTMLElement;
  console.log(`[NextCard Amex] Clicking card option: ${targetOption.textContent?.trim().substring(0, 60)}`);
  targetOption.click();

  await runControl.sleep(5000, attemptId);
  return true;
}

// ── Scrape rewards dashboard page ────────────────────────────

function scrapeRewardsDashboard() {
  const data = {
    cardName: null as string | null,
    availablePoints: null as number | null,
    pendingPoints: null as number | null,
    benefits: [] as { name: string; amountUsed: number | null; totalAmount: number | null; remaining: number | null; period: string | null }[],
  };

  const cardNameEl = document.querySelector('[data-testid="simple_switcher_display_name"]');
  const cardNumberEl = document.querySelector('[data-testid="simple_switcher_display_number_val"]');
  if (cardNameEl) {
    const name = textOf(cardNameEl);
    const number = cardNumberEl ? textOf(cardNumberEl).replace(/[^0-9•·.]/g, "") : "";
    data.cardName = number ? `${name} (${number})` : name;
  }

  const vitals = document.getElementById("overview-vitals");
  if (vitals) {
    const desktopTiles = vitals.querySelectorAll('[data-testid="desktop-tile"]');
    for (const tile of desktopTiles) {
      const label = tile.querySelector('[id^="available-header"]');
      if (label) {
        const valueEl = tile.querySelector(".heading-sans-medium-bold");
        if (valueEl) {
          data.availablePoints = parseIntSafe(textOf(valueEl));
        }
        break;
      }
    }

    // Fallback: small-tile (mobile layout)
    if (data.availablePoints == null) {
      const smallTile = vitals.querySelector('[data-testid="small-tile"]');
      if (smallTile) {
        const label = smallTile.querySelector('[id^="available-header"]');
        if (label) {
          const valueEl = smallTile.querySelector(".heading-sans-medium-bold");
          if (valueEl) {
            data.availablePoints = parseIntSafe(textOf(valueEl));
          }
        }
      }
    }
  }

  // ── Benefit credit trackers ──────────────────────────────
  const seenNames = new Set<string>();
  const trackerComponents = document.querySelectorAll('[data-testid="tracker-component"]');

  for (const comp of trackerComponents) {
    const heading = comp.querySelector("h3");
    if (!heading) continue;

    const name = textOf(heading);
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);

    const progress = comp.querySelector("progress");
    let amountUsed = progress ? parseFloat(progress.getAttribute("value") ?? "") : null;
    let totalAmount = progress ? parseFloat(progress.getAttribute("max") ?? "") : null;

    // Handle completed benefits with no progress element (e.g. "Congratulations, you've earned...")
    // Body text contains the actual period amount; the h3 heading may contain the annual total.
    if (!progress) {
      const compTextLower = textOf(comp).toLowerCase();
      if (compTextLower.includes("congratulations") || compTextLower.includes("you've earned") || compTextLower.includes("fully used")) {
        // Get body text (everything outside the heading) for the period-specific amount
        const bodyParts: string[] = [];
        for (const child of comp.children) {
          if (child.tagName !== "H3") bodyParts.push(textOf(child));
        }
        const bodyText = bodyParts.join(" ");
        const dollarMatch = bodyText.match(/\$([\d,]+(?:\.\d{2})?)/);

        if (dollarMatch) {
          totalAmount = parseFloat(dollarMatch[1].replace(/,/g, ""));
        } else {
          const nameDollarMatch = name.match(/\$([\d,]+)/);
          if (nameDollarMatch) totalAmount = parseFloat(nameDollarMatch[1].replace(/,/g, ""));
        }
        amountUsed = totalAmount;
      }
    }

    const remaining = amountUsed != null && totalAmount != null && !isNaN(amountUsed) && !isNaN(totalAmount)
      ? Math.round((totalAmount - amountUsed) * 100) / 100
      : null;

    data.benefits.push({
      name,
      amountUsed: amountUsed != null && !isNaN(amountUsed) ? amountUsed : null,
      totalAmount: totalAmount != null && !isNaN(totalAmount) ? totalAmount : null,
      remaining,
      period: null,
    });
  }

  // ── Enrollment-only benefits (no dollar tracker) ─────────
  const benefitsPreview = document.getElementById("axp-benefits-preview");
  if (benefitsPreview) {
    const benefitTiles = benefitsPreview.querySelectorAll('[data-testid="desktop-tile"]');
    for (const tile of benefitTiles) {
      const headingEl = tile.querySelector("h3");
      if (!headingEl) continue;

      const name = textOf(headingEl);
      if (!name || seenNames.has(name)) continue;
      seenNames.add(name);

      const statusEl = tile.querySelector('[data-testid="enroll-status"] [data-status] p');
      const enrollmentStatus = statusEl ? textOf(statusEl) : null;

      data.benefits.push({
        name,
        amountUsed: null,
        totalAmount: null,
        remaining: null,
        period: enrollmentStatus,
      });
    }

    // Fallback: mobile tiles
    if (data.benefits.length === 0) {
      const mobileTiles = benefitsPreview.querySelectorAll('[data-testid="mobile-tile"]');
      for (const tile of mobileTiles) {
        const headingEl = tile.querySelector("h3");
        if (!headingEl) continue;

        const name = textOf(headingEl);
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);

        const statusEl = tile.querySelector('[data-testid="enroll-status"] [data-status] p');
        const enrollmentStatus = statusEl ? textOf(statusEl) : null;

        data.benefits.push({
          name,
          amountUsed: null,
          totalAmount: null,
          remaining: null,
          period: enrollmentStatus,
        });
      }
    }
  }

  console.log("[NextCard Amex] Scraped data:", data);
  return data;
}

// ── Orchestration ────────────────────────────────────────────

async function waitForContentAndExpand(attemptId: string) {
  await waitForSelector("#overview-vitals, [data-testid='tracker-grid-component']");
  runControl.throwIfCancelled(attemptId);

  // Click "Show All" to expand all trackers if the button exists
  const showAllBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Show All");
  if (showAllBtn) {
    console.log("[NextCard Amex] Clicking Show All to expand trackers...");
    showAllBtn.click();
    await runControl.sleep(3000, attemptId);
  } else {
    await runControl.sleep(4000, attemptId);
  }
}

async function runExtraction(attemptId: string, cardIndex?: number) {
  const loginState = detectLoginState();
  console.log("[NextCard Amex] Login state:", loginState);
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
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
  console.log("[NextCard Amex] Checking page state...");

  // Wait for either the rewards content OR a non-eligible/unavailable state to appear.
  // Non-MR cards show "isn't eligible" instead of #overview-vitals.
  // Cancelled cards show "Page Unavailable" instead of #overview-vitals.
  await waitForSelector('#overview-vitals, [data-testid="simple_switcher_display_status"]', 8000);
  await runControl.sleep(1500, attemptId);

  const statusEl = document.querySelector('[data-testid="simple_switcher_display_status"]');
  const currentStatus = statusEl ? textOf(statusEl).toLowerCase() : "";
  const isCurrentCancelled = currentStatus.includes("cancel") || currentStatus.includes("closed");
  const bodyText = document.body.innerText;
  const isNotEligible = bodyText.includes("isn't eligible") || bodyText.includes("not eligible");
  const pageUnavailable = !document.getElementById("overview-vitals") &&
    (bodyText.includes("Page Unavailable") || bodyText.includes("has been cancelled") || isNotEligible);

  console.log(`[NextCard Amex] Page state: cancelled=${isCurrentCancelled}, notEligible=${isNotEligible}, unavailable=${pageUnavailable}`);

  if ((isCurrentCancelled || pageUnavailable) && cardIndex == null) {
    // First card is cancelled — find an active card and switch to it
    console.log("[NextCard Amex] Current card is cancelled/unavailable, finding active card...");
    const allOptions = await getCardOptions();
    const firstActive = allOptions.find((c) => !c.isCancelled);
    if (firstActive) {
      console.log(`[NextCard Amex] Switching to first active card: ${firstActive.name}`);
      const switched = await openSwitcherAndClickCard(firstActive.index, attemptId);
      if (switched) {
        await waitForContentAndExpand(attemptId);
      }
    }
  } else {
    await waitForContentAndExpand(attemptId);

    // Fallback: if content didn't load, recheck for cancelled state
    if (!document.getElementById("overview-vitals") && cardIndex == null) {
      const recheckStatus = document.querySelector('[data-testid="simple_switcher_display_status"]');
      const recheckText = recheckStatus ? textOf(recheckStatus).toLowerCase() : "";
      const recheckBody = document.body.innerText;
      const recheckUnavailable = recheckBody.includes("Page Unavailable") || recheckBody.includes("has been cancelled") || recheckBody.includes("isn't eligible") || recheckBody.includes("not eligible");
      if (recheckText.includes("cancel") || recheckText.includes("closed") || recheckUnavailable) {
        console.log("[NextCard Amex] Content failed to load — card appears cancelled, finding active card...");
        const fallbackOptions = await getCardOptions();
        const fallbackActive = fallbackOptions.find((c) => !c.isCancelled);
        if (fallbackActive) {
          await openSwitcherAndClickCard(fallbackActive.index, attemptId);
          await waitForContentAndExpand(attemptId);
        }
      }
    }
  }

  if (cardIndex != null) {
    console.log(`[NextCard Amex] Switching to card index ${cardIndex}...`);
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

    // Check if this card is eligible for Membership Rewards before waiting for content
    await waitForSelector('#overview-vitals, [data-testid="simple_switcher_display_status"]', 8000);
    await runControl.sleep(1500, attemptId);
    const switchedBodyText = document.body.innerText;
    const switchedNotEligible = switchedBodyText.includes("isn't eligible") || switchedBodyText.includes("not eligible");
    const switchedPageUnavailable = switchedBodyText.includes("Page Unavailable") || switchedBodyText.includes("has been cancelled");

    if (switchedNotEligible || switchedPageUnavailable) {
      const cardNameEl = document.querySelector('[data-testid="simple_switcher_display_name"]');
      const cardLabel = cardNameEl ? textOf(cardNameEl) : `card index ${cardIndex}`;
      console.log(`[NextCard Amex] Card "${cardLabel}" is not eligible for Membership Rewards, skipping`);
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
  const scraped = scrapeRewardsDashboard();

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
    sendResponse({ state: detectLoginState() });
  }
  if (message.type === "GET_CARD_OPTIONS") {
    getCardOptions().then((options) => {
      sendResponse({ options: options.filter((c) => !c.isCancelled) });
    });
    return true; // keep channel open for async response
  }
  if (message.type === "AMEX_ALL_DONE") {
    hideOverlay();
    sendResponse({ ok: true });
  }
  return true;
});

const initialState = detectLoginState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "amex" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "amex");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "amex");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "amex", state: initialState }).catch(() => {});
console.log("[NextCard Amex] Content script loaded. Login state:", initialState);
