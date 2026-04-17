/**
 * Shared page overlay for content scripts.
 *
 * Injects a fixed-position status banner into the host page DOM so the user
 * knows nextcard is working and shouldn't navigate away.  Uses Shadow DOM to
 * avoid style collisions with the host page.
 *
 * Usage (from any content script):
 *   import { showOverlay, updateOverlay, hideOverlay } from "../lib/overlay";
 *   showOverlay("waiting_for_login");   // user needs to sign in
 *   updateOverlay("extracting");        // scraping in progress
 *   hideOverlay();                      // done — auto-fades after brief "Done"
 */

type OverlayStatus = "waiting_for_login" | "mfa_challenge" | "extracting" | "done" | "cancelled" | "error";

const HOST_ID = "nextcard-sync-overlay";
const ICON_URL = chrome.runtime.getURL("src/icons/icon128.png");

// Keep a reference so we can update / remove later
let hostEl: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let currentStatus: OverlayStatus | null = null;
let knownProvider: string | null = null;
let lastProgressMessage: string | null = null;

function getStatusConfig(status: OverlayStatus) {
  switch (status) {
    case "waiting_for_login":
      return {
        heading: "nextcard is waiting for you to sign in",
        steps: [
          "Sign in to your account as you normally would",
          "Once logged in, we'll read your data automatically",
          "<strong>Don't close or navigate away from this tab</strong>",
        ],
        dotClass: "dot-waiting",
        showShield: true,
        showProgressMessage: false,
      };
    case "mfa_challenge":
      return {
        heading: "Complete the security verification",
        steps: [
          "We'll continue automatically once you're verified",
          "<strong>Don't close or navigate away from this tab</strong>",
        ],
        dotClass: "dot-waiting",
        showShield: true,
        showProgressMessage: false,
      };
    case "extracting":
      return {
        heading: "nextcard is reading your account",
        steps: [],
        dotClass: "dot-extracting",
        showShield: false,
        showProgressMessage: true,
      };
    case "done":
      return {
        heading: "All synced!",
        steps: [],
        dotClass: "dot-done",
        showShield: false,
        showProgressMessage: false,
      };
    case "error":
      return {
        heading: "Something went wrong",
        steps: ["Try syncing again from the nextcard sidebar"],
        dotClass: "dot-error",
        showShield: false,
        showProgressMessage: false,
      };
    case "cancelled":
      return {
        heading: "Sync cancelled",
        steps: [],
        dotClass: "dot-error",
        showShield: false,
        showProgressMessage: false,
      };
  }
}

const OVERLAY_STYLES = /* css */ `
  :host {
    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    font-family: "Nunito", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  :host(.nc-fade-out) .nc-backdrop {
    animation: nc-fade-out 0.35s ease-in forwards;
  }

  :host(.nc-fade-out) .nc-banner {
    animation: nc-banner-out 0.35s ease-in forwards;
  }

  /* ── Backdrop ── */

  .nc-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.45);
    pointer-events: none;
    animation: nc-backdrop-in 0.3s ease-out;
  }

  :host(.nc-login) {
    align-items: flex-end;
    padding: 0 16px 24px;
  }

  :host(.nc-login) .nc-backdrop {
    display: none;
  }

  @keyframes nc-backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @keyframes nc-slide-down {
    from { opacity: 0; transform: translateY(-20px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  @keyframes nc-fade-out {
    from { opacity: 1; }
    to   { opacity: 0; }
  }

  @keyframes nc-banner-out {
    from { opacity: 1; transform: translateY(0) scale(1); }
    to   { opacity: 0; transform: translateY(-12px) scale(0.97); }
  }

  .nc-banner {
    position: relative;
    display: flex;
    gap: 14px;
    background: #fefefe;
    color: #342019;
    pointer-events: auto;
    padding: 16px 20px;
    border-radius: 16px;
    box-shadow:
      0 12px 40px rgba(0, 0, 0, 0.2),
      0 4px 12px rgba(0, 0, 0, 0.1);
    max-width: 440px;
    width: calc(100% - 32px);
    border: 1px solid #f0ece8;
    animation: nc-slide-down 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* ── Logo ── */

  .nc-logo {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    object-fit: contain;
  }

  /* ── Body ── */

  .nc-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .nc-heading {
    font-size: 13.5px;
    font-weight: 700;
    color: #342019;
    display: flex;
    align-items: center;
    gap: 8px;
    letter-spacing: -0.2px;
    line-height: 1.2;
  }

  /* ── Status dot ── */

  .nc-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .dot-waiting {
    background: #f6b156;
    animation: nc-pulse 1.5s ease-in-out infinite;
  }

  .dot-extracting {
    background: #f6b156;
    animation: nc-pulse 0.9s ease-in-out infinite;
  }

  .dot-done {
    background: #34c759;
  }

  .dot-error {
    background: #ff3b30;
  }

  @keyframes nc-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }

  /* ── Step list ── */

  .nc-steps {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .nc-steps:empty { display: none; }

  .nc-step {
    font-size: 12px;
    font-weight: 400;
    color: #8c7a6e;
    line-height: 1.45;
    padding-left: 14px;
    position: relative;
  }

  .nc-step::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6.5px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #d0c8c0;
  }

  .nc-step strong {
    color: #342019;
    font-weight: 700;
  }

  /* ── Shield line ── */

  .nc-shield {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: 11px;
    color: #b0a49a;
    line-height: 1.3;
  }

  .nc-shield:empty { display: none; }

  .nc-shield svg {
    width: 12px;
    height: 12px;
    flex-shrink: 0;
    color: #b0a49a;
  }

  /* ── Progress bar (extracting only) ── */

  .nc-progress {
    height: 3px;
    border-radius: 2px;
    background: #f0ece8;
    overflow: hidden;
    margin-top: 2px;
  }

  .nc-progress:empty { display: none; }

  .nc-progress-bar {
    height: 100%;
    border-radius: 2px;
    background: #f6b156;
    animation: nc-indeterminate 1.8s ease-in-out infinite;
    width: 40%;
  }

  @keyframes nc-indeterminate {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(350%); }
  }

  /* ── Progress message (extracting only) ── */

  .nc-progress-message {
    font-size: 12px;
    color: #8c7a6e;
    line-height: 1.45;
    min-height: 17px;
    transition: opacity 0.2s ease;
    padding-left: 14px;
    position: relative;
  }

  .nc-progress-message::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6.5px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #f6b156;
    animation: nc-pulse 0.9s ease-in-out infinite;
  }

  .nc-progress-message:empty { display: none; }

  .nc-static-warning {
    font-size: 12px;
    font-weight: 700;
    color: #342019;
    line-height: 1.45;
    padding-left: 14px;
    position: relative;
  }

  .nc-static-warning::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6.5px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #d0c8c0;
  }
`;

const SHIELD_SVG = `<svg viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 1L2 3v2.5c0 2.73 1.7 5.28 4 6 2.3-.72 4-3.27 4-6V3L6 1z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>
  <path d="M4.5 6.25L5.5 7.25 7.5 5" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function buildBanner(status: OverlayStatus): string {
  const cfg = getStatusConfig(status);
  const stepsHtml = cfg.steps.length
    ? `<ul class="nc-steps">${cfg.steps.map((s) => `<li class="nc-step">${s}</li>`).join("")}</ul>`
    : "";
  const shieldHtml = cfg.showShield
    ? `<div class="nc-shield">${SHIELD_SVG} nextcard never sees or stores your login credentials</div>`
    : "";

  let extractingHtml = "";
  if (cfg.showProgressMessage) {
    extractingHtml = `
      <div class="nc-progress-message"></div>
      <div class="nc-static-warning">Don't click anything, close, or leave this page</div>
      <div class="nc-progress"><div class="nc-progress-bar"></div></div>
    `;
  } else if (status === "extracting") {
    extractingHtml = `<div class="nc-progress"><div class="nc-progress-bar"></div></div>`;
  }

  const logoHtml = `<img class="nc-logo" src="${ICON_URL}" alt="nextcard" />`;

  return `
    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet"/>
    <style>${OVERLAY_STYLES}</style>
    <div class="nc-backdrop"></div>
    <div class="nc-banner">
      ${logoHtml}
      <div class="nc-body">
        <div class="nc-heading">
          <span class="nc-dot ${cfg.dotClass}"></span>
          ${cfg.heading}
        </div>
        ${stepsHtml}
        ${extractingHtml}
        ${shieldHtml}
      </div>
    </div>
  `;
}

/**
 * Show the overlay banner on the page. If it already exists, updates it.
 * Automatically polls the service worker and dismisses when sync completes.
 */
function injectWhenReady(el: HTMLElement): void {
  if (document.body) {
    // Defer to next frame so the page's own rendering can start first
    requestAnimationFrame(() => document.body.appendChild(el));
  } else {
    // Body doesn't exist yet — wait for it
    const observer = new MutationObserver(() => {
      if (document.body) {
        observer.disconnect();
        requestAnimationFrame(() => document.body.appendChild(el));
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }
}

function startPollIfNeeded() {
  const p = knownProvider;
  if (!p || pollInterval) return;
  pollInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: p }, (r) => {
      if (chrome.runtime.lastError) return;
      const s = r?.status;
      // Keep long-running multi-page flows visually in sync as the worker advances.
      if (s === "extracting" && currentStatus !== "extracting") {
        updateOverlay("extracting");
      } else if (s === "waiting_for_login" && currentStatus !== "waiting_for_login" && currentStatus !== "mfa_challenge") {
        updateOverlay("waiting_for_login");
      } else if (s === "done") {
        hideOverlay("done");
      } else if (s === "error" || s === "cancelled") {
        hideOverlay(s === "error" ? "error" : "cancelled");
      }
      // Update progress message from service worker (for multi-phase/multi-card flows)
      if (s === "extracting" && r?.progressMessage) {
        updateOverlayProgress(r.progressMessage);
      }
    });
  }, 2000);
}

export function showOverlay(status: OverlayStatus, provider?: string): void {
  if (provider) knownProvider = provider;

  if (hostEl) {
    updateOverlay(status, provider);
    return;
  }

  hostEl = document.createElement("div");
  hostEl.id = HOST_ID;
  if (status === "waiting_for_login" || status === "mfa_challenge") hostEl.classList.add("nc-login");
  shadowRoot = hostEl.attachShadow({ mode: "closed" });
  shadowRoot.innerHTML = buildBanner(status);
  currentStatus = status;
  injectWhenReady(hostEl);

  startPollIfNeeded();
}

/**
 * Update the overlay status without recreating it.
 */
export function updateOverlay(status: OverlayStatus, provider?: string): void {
  if (provider) knownProvider = provider;

  if (!shadowRoot || !hostEl) {
    showOverlay(status, provider);
    return;
  }
  if (status === currentStatus) {
    startPollIfNeeded();
    return;
  }

  // Crossfade the banner content when switching states (e.g. waiting_for_login → extracting)
  const banner = shadowRoot.querySelector(".nc-banner") as HTMLElement | null;
  if (banner) {
    banner.style.transition = "opacity 0.25s ease";
    banner.style.opacity = "0";
    setTimeout(() => {
      if (status === "waiting_for_login" || status === "mfa_challenge") {
        hostEl!.classList.add("nc-login");
      } else {
        hostEl!.classList.remove("nc-login");
      }
      shadowRoot!.innerHTML = buildBanner(status);
      currentStatus = status;
      const newBanner = shadowRoot!.querySelector(".nc-banner") as HTMLElement | null;
      if (newBanner) {
        newBanner.style.opacity = "0";
        newBanner.style.transition = "opacity 0.3s ease";
        requestAnimationFrame(() => { newBanner.style.opacity = "1"; });
      }
    }, 250);
  } else {
    if (status === "waiting_for_login" || status === "mfa_challenge") {
      hostEl.classList.add("nc-login");
    } else {
      hostEl.classList.remove("nc-login");
    }
    shadowRoot.innerHTML = buildBanner(status);
    currentStatus = status;
  }

  startPollIfNeeded();
}

/**
 * Stop the overlay's automatic status polling. Use when the content script
 * manages the overlay lifecycle directly (e.g. Southwest in-place login).
 */
export function stopOverlayPoll(): void {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

/**
 * Update the animated progress message in the extracting overlay.
 * Crossfades to the new message. No-op if not in extracting state.
 */
export function updateOverlayProgress(message: string): void {
  if (!shadowRoot || currentStatus !== "extracting") return;
  if (message === lastProgressMessage) return;
  lastProgressMessage = message;

  const el = shadowRoot.querySelector(".nc-progress-message") as HTMLElement | null;
  if (!el) return;

  // Crossfade: fade out → swap text → fade in
  el.style.opacity = "0";
  setTimeout(() => {
    el.textContent = message;
    el.style.opacity = "1";
  }, 200);
}

/**
 * Hide the overlay with a brief "Done" flash, then remove from DOM.
 * Pass `"error"` to show the error state instead.
 */
export function hideOverlay(finalStatus: "done" | "error" | "cancelled" = "done"): void {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (!shadowRoot || !hostEl) return;

  updateOverlay(finalStatus);

  setTimeout(() => {
    if (hostEl) {
      hostEl.classList.add("nc-fade-out");
      setTimeout(() => {
        hostEl?.remove();
        hostEl = null;
        shadowRoot = null;
        currentStatus = null;
        knownProvider = null;
        lastProgressMessage = null;
      }, 350);
    }
  }, finalStatus === "done" ? 1500 : 800);
}
