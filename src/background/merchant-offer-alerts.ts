import {
  DETECTED_OFFER_URL_CACHE_KEY,
  OFFER_URL_CACHE_KEY,
  normalizeHostname,
  type CachedOffer,
  type OfferUrlCache,
} from "../lib/sync-offers-to-nextcard";

interface OfferGroup {
  merchantName: string;
  offerValue: string | null;
  rewardAmount: number;
  status: "enrolled" | "detected" | "mixed";
  cards: string[];
}

const ISSUER_HOSTNAMES = new Set([
  "chase.com",
  "secure.chase.com",
  "americanexpress.com",
  "global.americanexpress.com",
  "amex.com",
  "citi.com",
  "online.citi.com",
]);

const ALERT_ICON_PATH = "src/icons/icon128.png";
const IGNORED_OFFER_ALERT_HOSTS_KEY = "ignoredOfferAlertHosts";

function isScriptableUrl(url: string) {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isActiveOffer(offer: CachedOffer, now = Date.now()) {
  return !offer.expirationDate || new Date(offer.expirationDate).getTime() > now;
}

function getMatchingOffers(hostname: string, enrolledCache?: OfferUrlCache, detectedCache?: OfferUrlCache) {
  const now = Date.now();
  const enrolledOffers = (enrolledCache?.[hostname] ?? [])
    .filter((offer) => isActiveOffer(offer, now))
    .map((offer) => ({ ...offer, status: "enrolled" as const }));
  const detectedOffers = (detectedCache?.[hostname] ?? [])
    .filter((offer) => isActiveOffer(offer, now))
    .map((offer) => ({ ...offer, status: "detected" as const }));

  return [...enrolledOffers, ...detectedOffers];
}

async function maybeInjectOfferAlert(tab: chrome.tabs.Tab) {
  if (!tab.id || !tab.url || !isScriptableUrl(tab.url)) return;

  const hostname = normalizeHostname(tab.url);
  if (!hostname || ISSUER_HOSTNAMES.has(hostname)) return;

  const stored = await chrome.storage.local.get([
    OFFER_URL_CACHE_KEY,
    DETECTED_OFFER_URL_CACHE_KEY,
    IGNORED_OFFER_ALERT_HOSTS_KEY,
  ]);
  const ignoredHosts: Record<string, boolean> = stored[IGNORED_OFFER_ALERT_HOSTS_KEY] ?? {};
  if (ignoredHosts[hostname]) return;

  const matchingOffers = getMatchingOffers(
    hostname,
    stored[OFFER_URL_CACHE_KEY],
    stored[DETECTED_OFFER_URL_CACHE_KEY],
  );

  if (matchingOffers.length === 0) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectOfferToast,
      args: [
        matchingOffers,
        `nc_offer_dismissed_${hostname}`,
        chrome.runtime.getURL(ALERT_ICON_PATH),
        hostname,
        IGNORED_OFFER_ALERT_HOSTS_KEY,
      ],
    });
  } catch (error) {
    console.warn("[NextCard Offers] Failed to inject merchant alert:", error);
  }
}

export function registerMerchantOfferAlertMonitor() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab?.status === "complete") void maybeInjectOfferAlert(tab);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete" || !tab.active) return;
    void maybeInjectOfferAlert(tab);
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError || tab.status !== "complete") return;
      void maybeInjectOfferAlert(tab);
    });
  });
}

function injectOfferToast(
  offers: CachedOffer[],
  dismissKey: string,
  iconUrl: string,
  hostname: string,
  ignoredHostsKey: string,
): void {
  if (document.getElementById("nextcard-offer-toast")) return;

  let dismissed = false;
  try { dismissed = sessionStorage.getItem(dismissKey) !== null; } catch { /* */ }
  if (dismissed) return;

  const sorted = [...offers].sort((a, b) => (b.rewardAmount ?? 0) - (a.rewardAmount ?? 0));
  const hasDetectedOffers = sorted.some((offer) => offer.status === "detected");

  function esc(str: string): string {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  function cardLabel(offer: CachedOffer): string {
    const issuerDisplayNames: Record<string, string> = {
      amex: "American Express",
      americanexpress: "American Express",
      capitalone: "Capital One",
      capital_one: "Capital One",
      chase: "Chase",
      citi: "Citi",
      discover: "Discover",
    };
    const issuer = offer.issuer.trim();
    const issuerLabel = issuerDisplayNames[issuer.toLowerCase()] ?? issuer;
    const name = offer.cardName.trim() || `${issuerLabel} card`;
    return offer.cardLastDigits ? `${name} \u00B7\u00B7\u00B7\u00B7${offer.cardLastDigits}` : name;
  }

  function groupOffers(entries: CachedOffer[]): OfferGroup[] {
    const groups = new Map<string, OfferGroup>();

    for (const offer of entries) {
      const key = [
        offer.merchantName.trim().toLowerCase(),
        offer.offerValue?.trim().toLowerCase() ?? "",
        offer.rewardType ?? "",
        offer.rewardAmount ?? "",
      ].join("|");
      const label = cardLabel(offer);
      const group = groups.get(key);

      if (group) {
        if (!group.cards.includes(label)) group.cards.push(label);
        if (group.status !== offer.status) group.status = "mixed";
        continue;
      }

      groups.set(key, {
        merchantName: offer.merchantName,
        offerValue: offer.offerValue,
        rewardAmount: offer.rewardAmount ?? 0,
        status: offer.status ?? "enrolled",
        cards: [label],
      });
    }

    return Array.from(groups.values()).sort((a, b) => b.rewardAmount - a.rewardAmount);
  }

  const offerGroups = groupOffers(sorted);
  const title =
    offerGroups.length === 1
      ? "1 offer here"
      : `${offerGroups.length} offers here`;
  const offerRows = offerGroups.map((group) => {
    const offerText = group.offerValue ?? group.merchantName ?? "Special offer";
    const isDetectedGroup = group.status === "detected";
    const tagText = isDetectedGroup ? "AVAILABLE" : "OFFER";
    const tagClass = isDetectedGroup ? "nc-tag nc-tag-detected" : "nc-tag";
    const cardRows = group.cards
      .map((card) => `<div class="nc-card-row">${esc(card)}</div>`)
      .join("");

    return `
      <div class="nc-offer-group">
        <div class="nc-offer"><span>${esc(offerText)}</span><span class="${tagClass}">${tagText}</span></div>
        <div class="nc-card">Eligible cards</div>
        ${cardRows}
      </div>
    `;
  }).join("");

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
        align-items: flex-start;
        gap: 12px;
        background: #1a1a1a;
        color: #fff;
        padding: 14px 18px;
        border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.12);
        max-width: min(420px, calc(100vw - 40px));
        min-width: min(320px, calc(100vw - 40px));
        cursor: ${hasDetectedOffers ? "pointer" : "default"};
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
      .nc-body { display: flex; flex-direction: column; gap: 8px; flex: 1; min-width: 0; }
      .nc-title { font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.9); line-height: 1.2; }
      .nc-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: min(360px, calc(100vh - 80px));
        overflow-y: auto;
        padding-right: 2px;
      }
      .nc-offer-group {
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 8px;
      }
      .nc-offer-group:first-child { border-top: 0; padding-top: 0; }
      .nc-offer { font-size: 13.5px; font-weight: 600; line-height: 1.3; display: flex; align-items: center; gap: 6px; min-width: 0; }
      .nc-offer span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .nc-tag {
        background: #2d6b2d; color: #7deb7d; font-size: 10px; font-weight: 700;
        padding: 1px 6px; border-radius: 4px; letter-spacing: 0.3px;
        text-transform: uppercase; white-space: nowrap;
      }
      .nc-tag-detected { background: #6b5b2d; color: #ebd77d; }
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
      .nc-footer { display: flex; justify-content: flex-start; }
      .nc-ignore {
        background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.1);
        color: rgba(255,255,255,0.72); cursor: pointer; font: inherit;
        font-size: 11px; line-height: 1; padding: 6px 8px; border-radius: 6px;
      }
      .nc-ignore:hover { color: rgba(255,255,255,0.92); background: rgba(255,255,255,0.14); }
    </style>
    <div class="nc-toast">
      <img class="nc-icon" src="${iconUrl}" alt="nextcard" />
      <div class="nc-body">
        <div class="nc-title">${esc(title)}</div>
        <div class="nc-list">${offerRows}</div>
        <div class="nc-footer">
          <button class="nc-ignore" type="button">Don't show on this site</button>
        </div>
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
  shadow.querySelector(".nc-ignore")?.addEventListener("click", (e) => {
    e.stopPropagation();
    chrome.storage.local.get(ignoredHostsKey).then((stored) => {
      const ignoredHosts: Record<string, boolean> = stored[ignoredHostsKey] ?? {};
      return chrome.storage.local.set({
        [ignoredHostsKey]: { ...ignoredHosts, [hostname]: true },
      });
    }).catch(() => {});
    dismiss();
  });

  if (hasDetectedOffers) {
    shadow.querySelector(".nc-toast")?.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".nc-x")) return;
      chrome.storage.local.set({ pendingTab: "tools" });
      chrome.runtime.sendMessage({ type: "OPEN_TOOLS_TAB" }).catch(() => {});
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
