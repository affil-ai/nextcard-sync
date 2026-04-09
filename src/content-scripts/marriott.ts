/**
 * Content script for marriott.com (runs in ISOLATED WORLD).
 *
 * Pure DOM reading approach (CWS-compliant):
 * 1. Detects whether the user is logged in
 * 2. Waits for page content to render (SPA hydration)
 * 3. Reads loyalty data from the visible DOM
 * 4. Clicks "Nights Detail" to open the modal and read lifetime stats
 * 5. Closes the modal and reports data back to the service worker
 *
 * No main-world injection, no fetch/XHR patching.
 */

import type { MarriottLoyaltyData, LoginState, MarriottCertificate } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay } from "../lib/overlay";

const runControl = createContentScriptRunControl("marriott");

// ── Login detection ──────────────────────────────────────────

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();

  if (url.includes("/sign-in") || url.includes("/signin")) {
    return "logged_out";
  }

  const hasPasswordField = document.querySelector('input[type="password"]');
  const hasSignInForm =
    document.querySelector('form[action*="sign-in"]') ||
    document.querySelector('form[action*="signin"]');
  // Only treat as logged out if the password field is actually visible (not a pre-rendered hidden form)
  if (hasPasswordField && hasSignInForm && (hasPasswordField as HTMLElement).offsetParent !== null) return "logged_out";

  const signedInIndicators = [
    ".m-header__acnt",                                    // Account menu in header (most reliable)
    ".mp__member-details",                                // Account banner with points/status
    ".mp__member-points",                                 // Points display
    '[data-component-name="header-sign-in-success"]',
    ".m-header-sign-in-success",
    '[data-is-signed-in="true"]',
    ".m-account-menu",
    '[data-component-name="account-nav"]',
  ];

  for (const selector of signedInIndicators) {
    if (document.querySelector(selector)) return "logged_in";
  }

  const isAccountPage =
    url.includes("/loyalty/myaccount") || url.includes("/mybonvoy/");
  if (isAccountPage) return "logged_in";

  const signedOutIndicators = [
    'a[href*="sign-in"]',
    'a[href*="signin"]',
    'button[data-component-name="header-sign-in"]',
    '[class*="sign-in-btn"]',
  ];

  for (const selector of signedOutIndicators) {
    const el = document.querySelector(selector);
    if (el && (el as HTMLElement).offsetParent !== null) return "logged_out";
  }

  return "unknown";
}

// ── Wait for content to render ───────────────────────────────

/**
 * Waits for the actual account content to appear in the DOM.
 * Marriott's SPA renders the header shell first, then hydrates the main
 * content area asynchronously. We watch for known data selectors to appear
 * rather than relying on a generic mutation debounce.
 */
function waitForAccountContent(maxWaitMs = 30000): Promise<void> {
  // Wait for the main activity page content (the header banner with points/nights)
  const dataSelectors = [
    '.mp__member-points',                // Points display in the banner
    '.mp__member-level',                 // Elite status display
    'a[aria-label="Nights Detail"]',     // Nights Detail link in the banner
    '[class*="earned-rewards"]',         // Earned rewards section
    '.custom_click_track',               // Marriott's tracked links (appear in banner)
  ];

  const found = () => dataSelectors.some((s) => document.querySelector(s));

  return new Promise((resolve) => {
    if (found()) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      observer.disconnect();
      console.log("[NextCard] Timed out waiting for account content after 30s");
      resolve();
    }, maxWaitMs);

    const observer = new MutationObserver(() => {
      if (found()) {
        observer.disconnect();
        clearTimeout(timeout);
        setTimeout(resolve, 2500);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  });
}

// ── DOM helpers ──────────────────────────────────────────────

function collectTextElements(maxLength = 100): Array<{ el: Element; text: string }> {
  const results: Array<{ el: Element; text: string }> = [];
  const all = document.body.querySelectorAll("*");

  for (const el of all) {
    if ((el as HTMLElement).offsetParent === null && el.tagName !== "BODY") continue;

    const text = el.textContent?.trim() ?? "";
    if (text.length === 0 || text.length > maxLength) continue;

    results.push({ el, text });
  }

  return results;
}


// ── Status tiers ─────────────────────────────────────────────

const KNOWN_STATUSES = [
  "Ambassador Elite",
  "Titanium Elite",
  "Platinum Elite",
  "Gold Elite",
  "Silver Elite",
  "Member",
];

const STATUS_REGEX = /^(Ambassador|Titanium|Platinum|Gold|Silver)\s*(Elite)?$/i;

// ── Scrape the main activity page ────────────────────────────

function scrapeActivityPage(): Partial<MarriottLoyaltyData> {
  const data: Partial<MarriottLoyaltyData> = {};

  // ── Direct selectors (verified against live DOM) ──

  // Points: <span class="t-subtitle-xl mp__member-points">1,707</span>
  const pointsEl = document.querySelector(".mp__member-points");
  if (pointsEl) {
    data.pointsBalance = parseIntSafe(pointsEl.textContent?.trim() ?? "") ?? null;
  }

  // Status: <div class="mp__member-level t-subtitle-m">Silver Elite</div>
  const statusEl = document.querySelector(".mp__member-level");
  if (statusEl) {
    data.eliteStatus = statusEl.textContent?.trim() ?? null;
  }

  // Name: <div class="mp__member-name t-title-s">Vishal</div>
  const nameEl = document.querySelector(".mp__member-name");
  if (nameEl) {
    data.memberName = nameEl.textContent?.trim() ?? null;
  }

  // Nights: H3 elements matching "NN Nights"
  for (const h3 of document.querySelectorAll("h3")) {
    const nightsMatch = h3.textContent?.trim().match(/^(\d+)\s+Nights?$/i);
    if (nightsMatch) {
      data.eliteNightsCurrentYear = parseInt(nightsMatch[1], 10);
      break;
    }
  }

  // Points expiration: "qualifying activity* by Nov 21, 2027"
  const bodyText = document.body.textContent ?? "";
  const expiryMatch = bodyText.match(/qualifying activity[^.]*?by\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
  if (expiryMatch) {
    data.pointsExpirationDate = expiryMatch[1].trim();
  }

  // ── Fallbacks (text scanning) ──

  if (!data.pointsBalance || !data.eliteNightsCurrentYear) {
    const elements = collectTextElements();
    for (const { text } of elements) {
      if (!data.pointsBalance) {
        const pointsMatch = text.match(/^([\d,]+)\s+Points?$/i);
        if (pointsMatch) {
          data.pointsBalance = parseInt(pointsMatch[1].replace(/,/g, ""), 10);
        }
      }
      if (!data.eliteNightsCurrentYear) {
        const nightsMatch = text.match(/^(\d+)\s+Nights?$/i);
        if (nightsMatch) {
          data.eliteNightsCurrentYear = parseInt(nightsMatch[1], 10);
        }
      }
    }
    // Header fallback: "1,707 Point, 15 nights"
    if (!data.pointsBalance || !data.eliteNightsCurrentYear) {
      for (const { text } of elements) {
        const headerMatch = text.match(/([\d,]+)\s+Points?,\s*(\d+)\s+nights?/i);
        if (headerMatch) {
          if (!data.pointsBalance) data.pointsBalance = parseInt(headerMatch[1].replace(/,/g, ""), 10);
          if (!data.eliteNightsCurrentYear) data.eliteNightsCurrentYear = parseInt(headerMatch[2], 10);
          break;
        }
      }
    }
  }

  if (!data.eliteStatus) {
    for (const { text } of collectTextElements()) {
      for (const status of KNOWN_STATUSES) {
        if (text === status || text.includes(status)) {
          data.eliteStatus = status;
          break;
        }
      }
      if (data.eliteStatus) break;
      const statusMatch = text.match(STATUS_REGEX);
      if (statusMatch) {
        data.eliteStatus = statusMatch[2] ? `${statusMatch[1]} ${statusMatch[2]}` : `${statusMatch[1]} Elite`;
        break;
      }
    }
  }

  if (!data.memberName) {
    for (const { text } of collectTextElements()) {
      const greetingMatch = text.match(/^(?:Hi|Hello|Hey|Welcome),?\s+(.+)$/i);
      if (greetingMatch) {
        data.memberName = greetingMatch[1].trim();
        break;
      }
    }
  }

  // Member number
  const memberNumSelectors = [
    '[data-testid*="member-number"]',
    '[class*="member-number"]',
    '[class*="memberNumber"]',
    '[class*="membership-number"]',
    '[class*="account-number"]',
  ];

  for (const selector of memberNumSelectors) {
    const el = document.querySelector(selector);
    const t = el?.textContent?.trim();
    if (t) {
      const match = t.match(/\d{9,12}/);
      if (match) {
        data.memberNumber = match[0];
        break;
      }
    }
  }

  return data;
}

// ── Scrape the Nights Detail modal ──────────────────────────

/**
 * Clicks "Nights Detail" to open the modal, scrapes lifetime data, then closes it.
 *
 * The modal renders as a styled-components overlay (`.modal__container`), NOT
 * inside the `.mdc-dialog` elements. Inside it:
 * - `<div class="d-flex justify-content-between"><h6>Label</h6><h6>Value</h6></div>`
 * - `<div class="life-time-nights">` with `<div>Total Nights:45</div>`
 * - `<div class="lifetime-footer">` for years-as-status tiers
 */
async function scrapeNightsDetail(attemptId: string): Promise<Partial<MarriottLoyaltyData>> {
  const data: Partial<MarriottLoyaltyData> = {};

  // Click "Nights Detail" link
  const link = document.querySelector('a[aria-label="Nights Detail"]') as HTMLElement | null;
  if (!link) {
    console.log("[NextCard] Could not find Nights Detail link");
    return data;
  }

  console.log("[NextCard] Clicking Nights Detail...");
  runControl.throwIfCancelled(attemptId);
  link.click();

  // Wait for the styled-components modal to appear
  const modal = await waitForElement(".modal__container", 8000);
  if (!modal) {
    console.log("[NextCard] Nights Detail modal did not appear");
    return data;
  }

  // Extra delay for modal content to render
  await runControl.sleep(1500, attemptId);

  console.log("[NextCard] Scraping Nights Detail modal...");

  // H6 label/value pairs inside the modal
  const flexRows = modal.querySelectorAll(".d-flex.justify-content-between");
  for (const row of flexRows) {
    const h6s = row.querySelectorAll("h6");
    if (h6s.length < 2) continue;

    const label = h6s[0].textContent?.trim() ?? "";
    const value = h6s[1].textContent?.trim() ?? "";

    switch (label) {
      case "Nights Stayed":
        data.nightsStayed = parseIntSafe(value);
        break;
      case "Bonus Nights":
        data.bonusNights = parseIntSafe(value);
        break;
      case "Total Qualified Spend":
        data.totalQualifiedSpend = value || null;
        break;
    }
  }

  // Lifetime Nights section inside the modal
  const lifetimeNights = modal.querySelector(".life-time-nights");
  if (lifetimeNights) {
    for (const child of lifetimeNights.children) {
      const text = child.textContent?.trim() ?? "";
      const totalMatch = text.match(/Total\s*Nights\s*:?\s*(\d[\d,]*)/i);
      if (totalMatch) {
        data.eliteNightsLifetime = parseInt(totalMatch[1].replace(/,/g, ""), 10);
      }
    }
  }

  // Lifetime footer for years-as-status tiers
  const lifetimeFooter = modal.querySelector(".lifetime-footer");
  if (lifetimeFooter) {
    const footerRows = lifetimeFooter.querySelectorAll(".d-flex.justify-content-between");
    for (const row of footerRows) {
      const h6s = row.querySelectorAll("h6");
      if (h6s.length < 2) continue;
      const label = h6s[0].textContent?.trim() ?? "";
      const value = h6s[1].textContent?.trim() ?? "";

      if (label.match(/years?\s+as\s+silver/i)) {
        data.yearsAsSilverPlus = parseIntSafe(value);
      } else if (label.match(/years?\s+as\s+gold/i)) {
        data.yearsAsGoldPlus = parseIntSafe(value);
      } else if (label.match(/years?\s+as\s+platinum/i)) {
        data.yearsAsPlatinum = parseIntSafe(value);
      }
    }

    // Fallback: regex on the full footer text
    const footerText = lifetimeFooter.textContent ?? "";
    if (data.yearsAsSilverPlus == null) {
      const m = footerText.match(/Years?\s+as\s+Silver[^:]*:?\s*(\d+)/i);
      if (m) data.yearsAsSilverPlus = parseInt(m[1], 10);
    }
    if (data.yearsAsGoldPlus == null) {
      const m = footerText.match(/Years?\s+as\s+Gold[^:]*:?\s*(\d+)/i);
      if (m) data.yearsAsGoldPlus = parseInt(m[1], 10);
    }
    if (data.yearsAsPlatinum == null) {
      const m = footerText.match(/Years?\s+as\s+Platinum[^:]*:?\s*(\d+)/i);
      if (m) data.yearsAsPlatinum = parseInt(m[1], 10);
    }
  }

  // Next tier target
  const modalText = modal.textContent ?? "";
  const targetMatch = modalText.match(
    /Stay\s+(\d+)\s+more\s+nights?\s+by\s+(\w+\s+\d+)\s+to\s+reach\s+([\w\s]+?)(?:\.|$)/i
  );
  if (targetMatch) {
    data.nextTierTarget = `${targetMatch[1]} more nights to ${targetMatch[3].trim()}`;
  }

  console.log("[NextCard] Nights Detail data:", data);

  // Close the modal
  closeNightsModal();

  return data;
}

/**
 * Wait for an element matching a selector to appear in the DOM.
 */
function waitForElement(selector: string, maxWaitMs = 8000): Promise<Element | null> {
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

function closeNightsModal() {
  // The modal close button: <div class="popup-close" role="button" aria-label="Close button">
  const closeBtn = document.querySelector('.popup-close[role="button"]') as HTMLElement | null;
  if (closeBtn) {
    closeBtn.click();
    console.log("[NextCard] Closed modal via popup-close");
    return;
  }

  // Fallback: Escape key
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  console.log("[NextCard] Closed modal via Escape");
}

function parseIntSafe(str: string, max = 100000): number | null {
  const cleaned = str.replace(/[$,]/g, "");
  const num = parseInt(cleaned, 10);
  if (Number.isNaN(num) || num > max) return null;
  return num;
}


// ── Earned rewards / certificate scraping ─────────────────────

const AWARD_PATTERNS = [
  { regex: /suite\s*night\s*award/i, type: "Suite Night Award" },
  { regex: /free\s*night\s*award/i, type: "Free Night Award" },
  { regex: /annual\s*choice\s*benefit/i, type: "Annual Choice Benefit" },
  { regex: /confirmed\s*suite\s*upgrade/i, type: "Confirmed Suite Upgrade" },
  { regex: /united\s*club\s*pass/i, type: "United Club Pass" },
  { regex: /gift\s*(?:of\s*)?gold/i, type: "Gift of Gold Elite" },
  { regex: /gift\s*(?:of\s*)?silver/i, type: "Gift of Silver Elite" },
  { regex: /gift\s*(?:of\s*)?platinum/i, type: "Gift of Platinum Elite" },
];

const DATE_PATTERN = String.raw`(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})`;
const EXPIRY_REGEX = new RegExp(
  String.raw`(?:Expires?|Expiration|Valid\s+(?:through|until|thru))[:\s]*` + DATE_PATTERN,
  "i"
);

function scrapeEarnedRewards(): MarriottCertificate[] {
  const certs: MarriottCertificate[] = [];

  const allElements = Array.from(document.body.querySelectorAll("*"))
    .filter((el) => {
      const text = el.textContent?.trim() ?? "";
      return text.length >= 10 && text.length <= 500;
    })
    .filter((el) => (el as HTMLElement).offsetParent !== null)
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));

  const seenDescriptions = new Set<string>();

  for (const el of allElements) {
    const text = el.textContent?.trim() ?? "";
    const lowerText = text.toLowerCase();

    let awardType: string | null = null;
    for (const { regex, type } of AWARD_PATTERNS) {
      if (regex.test(lowerText)) {
        awardType = type;
        break;
      }
    }
    if (!awardType) continue;

    // Must have descriptive detail — skip summary badges and headers
    const hasDetail =
      lowerText.includes("valued") ||
      (lowerText.includes("expires") && lowerText.includes("award"));

    if (!hasDetail) continue;

    // Skip parent containers — if any child of this element already matched,
    // skip this one (since elements are sorted smallest-first, children
    // are processed before parents)
    if (el.querySelectorAll("*").length > 20) continue;

    // Extract the specific award description line
    const descMatch = text.match(
      /((?:Free|Suite)\s+Night\s+Award\s+valued\s+up\s+to\s+[\w\d,]+\s*(?:pts|points)?[^]*?)(?=\s*Expires?|\s*$)/i
    );

    if (!descMatch) continue;

    const description = descMatch[1]
      .replace(/\s+/g, " ")
      .trim();

    if (seenDescriptions.has(description)) continue;
    seenDescriptions.add(description);

    const expiryMatch = text.match(EXPIRY_REGEX);
    const expiryDate = expiryMatch ? expiryMatch[1].trim() : null;

    let propertyCategory: string | null = null;
    const ptsMatch = description.match(/up\s+to\s+([\d,]+K?)\s*(?:pts|points)/i);
    if (ptsMatch) {
      propertyCategory = `Up to ${ptsMatch[1]} points`;
    }

    certs.push({ type: awardType, description, expiryDate, propertyCategory });
  }

  return certs;
}

// ── Orchestration ────────────────────────────────────────────

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  console.log("[NextCard] Login state:", loginState);
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
    console.log("[NextCard] User not logged in. Signaling service worker to wait.");
    showOverlay("waiting_for_login", "marriott");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "marriott");
  console.log("[NextCard] User is logged in, waiting for account content to render...");
  await waitForAccountContent();

  // 1. Scrape the main activity page (points, status, nights, name)
  runControl.throwIfCancelled(attemptId);
  const accountData = scrapeActivityPage();
  console.log("[NextCard] Account data:", accountData);

  // 2. Scrape certificates from the earned rewards section
  const certs = scrapeEarnedRewards();
  console.log("[NextCard] Certificates:", certs);

  // 3. Click "Nights Detail" to open modal, scrape lifetime data, then close
  const nightsData = await scrapeNightsDetail(attemptId);
  console.log("[NextCard] Nights Detail data:", nightsData);

  // Merge everything
  const finalData: MarriottLoyaltyData = {
    pointsBalance: accountData.pointsBalance ?? null,
    eliteStatus: accountData.eliteStatus ?? null,
    eliteNightsCurrentYear: accountData.eliteNightsCurrentYear ?? null,
    eliteNightsLifetime: nightsData.eliteNightsLifetime ?? null,
    nightsStayed: nightsData.nightsStayed ?? null,
    bonusNights: nightsData.bonusNights ?? null,
    totalQualifiedSpend: nightsData.totalQualifiedSpend ?? null,
    nextTierTarget: nightsData.nextTierTarget ?? null,
    yearsAsSilverPlus: nightsData.yearsAsSilverPlus ?? null,
    yearsAsGoldPlus: nightsData.yearsAsGoldPlus ?? null,
    yearsAsPlatinum: nightsData.yearsAsPlatinum ?? null,
    certificates: certs,
    memberNumber: accountData.memberNumber ?? null,
    memberName: accountData.memberName ?? null,
    pointsExpirationDate: null,
  };

  await runControl.sendMessage(attemptId, { type: "EXTRACTION_DONE", data: finalData });
  console.log("[NextCard] Extraction complete:", finalData);
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

// Report initial login state on load
const initialState = detectLoginState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "marriott" }, (r) => {
  const s = r?.status;
  if (s === "extracting" || (s === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "marriott");
  } else if ((s === "waiting_for_login" || s === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "marriott");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "marriott", state: initialState }).catch(() => {
  // Service worker might not be ready yet
});
console.log("[NextCard] Content script loaded. Login state:", initialState);
