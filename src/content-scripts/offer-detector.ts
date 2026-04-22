/**
 * Lightweight content script that runs on all pages at document_idle.
 * Checks if the current hostname matches any enrolled or detected merchant offer
 * in chrome.storage.local and shows a toast if so.
 *
 * Registered in manifest.json on <all_urls> so Chrome auto-grants
 * site access at install time.
 */

const OFFER_URL_CACHE_KEY = "offerUrlCache";
const DETECTED_OFFER_URL_CACHE_KEY = "detectedOfferUrlCache";

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
  status?: "enrolled" | "detected";
}

const hostname = location.hostname.replace(/^www\./, "").toLowerCase();

if (!ISSUER_HOSTNAMES.has(hostname)) {
  const dismissKey = `nc_offer_dismissed_${hostname}`;
  let dismissed = false;
  try { dismissed = sessionStorage.getItem(dismissKey) !== null; } catch { /* */ }

  if (!dismissed) {
    chrome.storage.local.get([OFFER_URL_CACHE_KEY, DETECTED_OFFER_URL_CACHE_KEY]).then((stored) => {
      const enrolledCache: Record<string, CachedOffer[]> | undefined = stored[OFFER_URL_CACHE_KEY];
      const detectedCache: Record<string, CachedOffer[]> | undefined = stored[DETECTED_OFFER_URL_CACHE_KEY];

      const now = new Date();
      const filterActive = (offers: CachedOffer[]) =>
        offers.filter((o) => !o.expirationDate || new Date(o.expirationDate) > now);

      // Enrolled offers take priority
      const enrolledOffers = filterActive(enrolledCache?.[hostname] ?? []);
      if (enrolledOffers.length > 0) {
        showToast(enrolledOffers, dismissKey, "enrolled");
        return;
      }

      const detectedOffers = filterActive(detectedCache?.[hostname] ?? []);
      if (detectedOffers.length > 0) {
        showToast(detectedOffers, dismissKey, "detected");
      }
    });
  }
}

function showToast(offers: CachedOffer[], dismissKey: string, type: "enrolled" | "detected"): void {
  if (document.getElementById("nextcard-offer-toast")) return;

  const sorted = [...offers].sort((a, b) => (b.rewardAmount ?? 0) - (a.rewardAmount ?? 0));
  const best = sorted[0];

  const offerText = best.offerValue ?? "Special offer";
  const cardText = best.cardLastDigits
    ? `${best.cardName} \u00B7\u00B7\u00B7\u00B7${best.cardLastDigits}`
    : best.cardName;

  // Build list of unique card labels
  const seenCards = new Set<string>();
  const cardLabels: string[] = [];
  for (const o of sorted) {
    const key = `${o.issuer}:${o.cardLastDigits ?? o.cardName}`;
    if (seenCards.has(key)) continue;
    seenCards.add(key);
    cardLabels.push(o.cardLastDigits ? `${o.cardName} \u00B7\u00B7\u00B7\u00B7${o.cardLastDigits}` : o.cardName);
  }

  const isDetected = type === "detected";
  const tagText = isDetected ? "AVAILABLE" : "OFFER";
  const tagBg = isDetected ? "#6b5b2d" : "#2d6b2d";
  const tagColor = isDetected ? "#ebd77d" : "#7deb7d";
  const subtitle = isDetected
    ? cardLabels.map((c) => `<div class="nc-card-row">${esc(c)}</div>`).join("")
    : `Use ${esc(cardText)}`;

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
        cursor: ${isDetected ? "pointer" : "default"};
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
        background: ${tagBg}; color: ${tagColor}; font-size: 10px; font-weight: 700;
        padding: 1px 6px; border-radius: 4px; letter-spacing: 0.3px;
        text-transform: uppercase; white-space: nowrap;
      }
      .nc-card { font-size: 12px; color: rgba(255,255,255,0.55); line-height: 1.3; }
      .nc-card-row { font-size: 11.5px; color: rgba(255,255,255,0.55); line-height: 1.4; padding-left: 10px; position: relative; }
      .nc-card-row::before { content: "·"; position: absolute; left: 2px; font-weight: 700; }
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
        <div class="nc-offer"><span>${esc(offerText)}</span><span class="nc-tag">${tagText}</span></div>
        ${isDetected ? `<div class="nc-card" style="margin-bottom:2px;">Add to</div>${subtitle}` : `<div class="nc-card">${subtitle}</div>`}
        ${!isDetected && offers.length > 1 ? `<div class="nc-more">+${offers.length - 1} more offer${offers.length > 2 ? "s" : ""}</div>` : ""}
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

  if (isDetected) {
    shadow.querySelector(".nc-toast")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".nc-x")) return;
      chrome.storage.local.set({ pendingTab: "tools" });
      chrome.runtime.sendMessage({ type: "OPEN_TOOLS_TAB" }).catch(() => {});
      // Transform toast into a nudge to click the extension icon
      const body = shadow.querySelector(".nc-body");
      if (body) {
        body.innerHTML = `
          <div class="nc-offer"><span>Open nextcard sync</span></div>
          <div class="nc-card">Click the extension icon in your toolbar</div>
        `;
      }
    });
  }

  setTimeout(dismiss, 8000);
  document.body.appendChild(host);
}
