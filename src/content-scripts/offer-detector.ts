/**
 * Lightweight content script that runs on all pages at document_idle.
 * Checks if the current hostname matches any enrolled merchant offer
 * in chrome.storage.local and shows a toast if so.
 *
 * Registered in manifest.json on <all_urls> so Chrome auto-grants
 * site access at install time.
 */

const OFFER_URL_CACHE_KEY = "offerUrlCache";

const ISSUER_HOSTNAMES = new Set([
  "chase.com",
  "secure.chase.com",
  "americanexpress.com",
  "global.americanexpress.com",
  "amex.com",
  "citi.com",
  "online.citi.com",
]);

interface CachedOffer {
  merchantName: string;
  offerValue: string | null;
  cardName: string;
  cardLastDigits: string | null;
  expirationDate: string | null;
  issuer: string;
  rewardType: "percentage" | "flat_cash" | "points" | null;
  rewardAmount: number | null;
}

const hostname = location.hostname.replace(/^www\./, "").toLowerCase();

if (!ISSUER_HOSTNAMES.has(hostname)) {
  const dismissKey = `nc_offer_dismissed_${hostname}`;
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(dismissKey) !== null; } catch { /* */ }

  if (!dismissed) {
    chrome.storage.local.get(OFFER_URL_CACHE_KEY).then((stored) => {
      const cache: Record<string, CachedOffer[]> | undefined = stored[OFFER_URL_CACHE_KEY];
      if (!cache) return;

      const offers = cache[hostname];
      if (!offers?.length) return;

      const now = new Date();
      const active = offers.filter(
        (o) => !o.expirationDate || new Date(o.expirationDate) > now,
      );
      if (!active.length) return;

      showToast(active, dismissKey);
    });
  }
}

function showToast(offers: CachedOffer[], dismissKey: string): void {
  if (document.getElementById("nextcard-offer-toast")) return;

  const sorted = [...offers].sort((a, b) => (b.rewardAmount ?? 0) - (a.rewardAmount ?? 0));
  const best = sorted[0];
  const moreCount = offers.length - 1;

  const offerText = best.offerValue ?? "Special offer";
  const cardText = best.cardLastDigits
    ? `${best.cardName} \u00B7\u00B7\u00B7\u00B7${best.cardLastDigits}`
    : best.cardName;
  const moreLabel = moreCount > 0 ? ` +${moreCount} more` : "";

  function esc(str: string): string {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  const iconUrl = chrome.runtime.getURL("src/icons/icon128.png");

  const host = document.createElement("div");
  host.id = "nextcard-offer-toast";
  const shadow = host.attachShadow({ mode: "closed" });

  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
        pointer-events: auto;
      }
      .nc-toast {
        display: flex;
        align-items: center;
        gap: 12px;
        background: #1a1a1a;
        color: #fff;
        padding: 14px 18px;
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.12);
        max-width: 400px;
        min-width: 280px;
        cursor: default;
        animation: nc-in 0.4s cubic-bezier(0.16,1,0.3,1);
        border: 1px solid rgba(255,255,255,0.08);
      }
      .nc-toast.nc-out { animation: nc-out 0.3s ease-in forwards; }
      @keyframes nc-in {
        from { opacity: 0; transform: translateX(100px); }
        to   { opacity: 1; transform: translateX(0); }
      }
      @keyframes nc-out {
        from { opacity: 1; transform: translateX(0); }
        to   { opacity: 0; transform: translateX(100px); }
      }
      .nc-icon { width: 28px; height: 28px; flex-shrink: 0; border-radius: 6px; }
      .nc-body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
      .nc-offer { font-size: 13.5px; font-weight: 600; line-height: 1.3; display: flex; align-items: center; gap: 6px; }
      .nc-tag {
        background: #2d6b2d; color: #7deb7d; font-size: 10px; font-weight: 700;
        padding: 1px 6px; border-radius: 4px; letter-spacing: 0.3px;
        text-transform: uppercase; white-space: nowrap;
      }
      .nc-card { font-size: 12px; color: rgba(255,255,255,0.55); line-height: 1.3; }
      .nc-more { font-size: 11px; color: rgba(255,255,255,0.4); line-height: 1.3; }
      .nc-x {
        background: none; border: none; color: rgba(255,255,255,0.35); cursor: pointer;
        padding: 4px; margin: -4px -4px -4px 0; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        border-radius: 6px; transition: color 0.15s, background 0.15s;
      }
      .nc-x:hover { color: rgba(255,255,255,0.7); background: rgba(255,255,255,0.1); }
      .nc-x svg { width: 16px; height: 16px; }
    </style>
    <div class="nc-toast">
      <img class="nc-icon" src="${iconUrl}" alt="nextcard" />
      <div class="nc-body">
        <div class="nc-offer"><span>${esc(offerText)}</span><span class="nc-tag">OFFER</span></div>
        <div class="nc-card">Use ${esc(cardText)}</div>
        ${moreLabel ? `<div class="nc-more">${esc(moreLabel)} offer${moreCount > 1 ? "s" : ""}</div>` : ""}
      </div>
      <button class="nc-x" aria-label="Dismiss">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>
        </svg>
      </button>
    </div>
  `;

  function dismiss() {
    const toast = shadow.querySelector(".nc-toast");
    if (toast) {
      toast.classList.add("nc-out");
      setTimeout(() => host.remove(), 300);
    } else {
      host.remove();
    }
    try { sessionStorage.setItem(dismissKey, "1"); } catch { /* */ }
  }

  shadow.querySelector(".nc-x")?.addEventListener("click", dismiss);
  setTimeout(dismiss, 8000);
  document.body.appendChild(host);
}
