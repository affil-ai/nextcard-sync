/**
 * Discover 5% Cashback Bonus — auto-activate the quarterly 5% category.
 *
 * Flow: navigate to rewards/5percent page → detect login → show overlay →
 * click "Activate Now" → hide overlay → done.
 */

import { showOverlay, updateOverlay, updateOverlayProgress, hideOverlay } from "../lib/overlay";

// ── Login detection ────────────────────────────────────────

function detectLogin(): "logged_in" | "logged_out" | "unknown" {
  const url = window.location.href.toLowerCase();
  if (url.includes("/login") || url.includes("/logoff") || url.includes("/logon")) return "logged_out";
  if (url.includes("card.discover.com")) return "logged_in";
  return "unknown";
}

// ── Find and click the Activate button ─────────────────────

function findActivateButton(): HTMLElement | null {
  // Primary: look for the specific activate button with data-testid
  const btn = document.querySelector('button.activate-btn[data-testid="dfs-react-ui__button"]') as HTMLElement | null;
  if (btn) return btn;

  // Fallback: any button with "Activate Now" text
  const candidates = document.querySelectorAll("button, a, [role='button']");
  for (const el of candidates) {
    const text = el.textContent?.trim().toLowerCase() ?? "";
    if (text === "activate now") {
      return el as HTMLElement;
    }
  }
  return null;
}

function isAlreadyActivated(): boolean {
  // Only consider it activated if there's NO activate button on the page
  return !findActivateButton();
}

// ── Helpers ────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForElement(check: () => HTMLElement | null, maxWaitMs = 15000): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const existing = check();
    if (existing) { resolve(existing); return; }

    const timeout = setTimeout(() => { observer.disconnect(); resolve(null); }, maxWaitMs);
    const observer = new MutationObserver(() => {
      const el = check();
      if (el) { observer.disconnect(); clearTimeout(timeout); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ── Main flow ──────────────────────────────────────────────

async function activateBonus(): Promise<{ success: boolean; alreadyActive: boolean; error: string | null }> {
  showOverlay("extracting", "discover");
  updateOverlayProgress("Looking for 5% bonus activation...");

  await delay(2000);

  // Check if already activated
  if (isAlreadyActivated()) {
    updateOverlayProgress("Already activated!");
    await delay(1000);
    hideOverlay("done");
    return { success: true, alreadyActive: true, error: null };
  }

  // Find the Activate Now button
  updateOverlayProgress("Finding Activate button...");
  const btn = await waitForElement(findActivateButton, 10000);

  if (!btn) {
    if (isAlreadyActivated()) {
      updateOverlayProgress("Already activated!");
      await delay(1000);
      hideOverlay("done");
      return { success: true, alreadyActive: true, error: null };
    }
    hideOverlay("error");
    return { success: false, alreadyActive: false, error: "Could not find Activate button" };
  }

  updateOverlayProgress("Activating 5% bonus...");
  btn.click();

  await delay(3000);

  if (isAlreadyActivated()) {
    updateOverlayProgress("Activated!");
    await delay(1500);
    hideOverlay("done");
    return { success: true, alreadyActive: false, error: null };
  }

  // Try clicking a confirmation button if one appeared
  const confirmBtn = findActivateButton();
  if (confirmBtn && confirmBtn !== btn) {
    confirmBtn.click();
    await delay(2000);
  }

  updateOverlayProgress("Done!");
  await delay(1000);
  hideOverlay("done");
  return { success: true, alreadyActive: false, error: null };
}

// ── Message listener ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "DISCOVER_BONUS_ACTIVATE") {
    (async () => {
      const result = await activateBonus();
      sendResponse(result);
    })();
    return true;
  }
});

