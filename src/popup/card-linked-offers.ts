import {
  CARD_LINKED_OFFERS_STORAGE_KEY,
  getOfferValueLabel,
  isCurrentCardLinkedOffer,
  parseCardLinkedOffers,
  sortCardLinkedOffers,
  type CardLinkedOffer,
} from "../lib/card-linked-offers";
import { pullOfferUrlCache } from "../lib/sync-offers-to-nextcard";
import { openOffers } from "./renderers/shared";

const DISPLAY_LIMIT = 6;

function getIssuerLabel(issuer: string): string {
  const labels: Record<string, string> = {
    amex: "American Express",
    americanexpress: "American Express",
    capitalone: "Capital One",
    capital_one: "Capital One",
    chase: "Chase",
    citi: "Citi",
    discover: "Discover",
  };
  return labels[issuer.trim().toLowerCase()] ?? issuer;
}

function getCardLabel(offer: CardLinkedOffer): string {
  const cardName = offer.cardName.trim() || `${getIssuerLabel(offer.issuer)} card`;
  return offer.cardLastDigits ? `${cardName} ····${offer.cardLastDigits}` : cardName;
}

function getExpirationLabel(expirationDate: string | null): string | null {
  if (!expirationDate) return null;
  const expiration = new Date(expirationDate);
  if (Number.isNaN(expiration.getTime())) return null;
  return `Ends ${expiration.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

function getMerchantUrl(offer: CardLinkedOffer): string | null {
  if (!offer.merchantUrl) return null;
  try {
    const url = new URL(offer.merchantUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function createOfferRow(offer: CardLinkedOffer): HTMLElement {
  const merchantUrl = getMerchantUrl(offer);
  const row = document.createElement(merchantUrl ? "button" : "div");
  row.className = "card-linked-offer-row";
  if (row instanceof HTMLButtonElement) {
    row.type = "button";
    row.title = `Open ${offer.merchantName}`;
    row.addEventListener("click", () => {
      void chrome.tabs.create({ url: merchantUrl ?? undefined });
    });
  }

  const header = document.createElement("span");
  header.className = "card-linked-offer-header";
  const merchant = document.createElement("strong");
  merchant.textContent = offer.merchantName;
  const status = document.createElement("span");
  status.className = `card-linked-offer-status ${offer.status}`;
  status.textContent = offer.status === "enrolled" ? "Added" : "Available";
  header.append(merchant, status);

  const value = document.createElement("span");
  value.className = "card-linked-offer-value";
  value.textContent = getOfferValueLabel(offer);

  const metadata = document.createElement("span");
  metadata.className = "card-linked-offer-metadata";
  const expiration = getExpirationLabel(offer.expirationDate);
  metadata.textContent = [getCardLabel(offer), expiration].filter(Boolean).join(" · ");

  row.append(header, value, metadata);
  return row;
}

function setRefreshState(refreshButton: HTMLButtonElement, refreshing: boolean): void {
  refreshButton.disabled = refreshing;
  refreshButton.setAttribute("aria-label", refreshing ? "Refreshing offers" : "Refresh offers");
  refreshButton.classList.toggle("refreshing", refreshing);
}

export async function initializeCardLinkedOffers(): Promise<void> {
  const list = document.getElementById("cardLinkedOffersList");
  const count = document.getElementById("cardLinkedOffersCount");
  const state = document.getElementById("cardLinkedOffersState");
  const refreshButton = document.getElementById("cardLinkedOffersRefresh") as HTMLButtonElement | null;
  const dashboardButton = document.getElementById("cardLinkedOffersDashboard");
  if (!list || !count || !state || !refreshButton || !dashboardButton) return;
  const listElement = list;
  const countElement = count;
  const stateElement = state;

  function render(rawOffers: unknown): void {
    const offers = sortCardLinkedOffers(
      parseCardLinkedOffers({ offers: rawOffers }).filter((offer) => isCurrentCardLinkedOffer(offer)),
    );
    countElement.textContent = String(offers.length);
    listElement.replaceChildren(...offers.slice(0, DISPLAY_LIMIT).map(createOfferRow));
    stateElement.hidden = offers.length > 0;
    stateElement.textContent = offers.length > 0
      ? ""
      : "No saved offers yet. Check a supported card to find offers.";
  }

  async function loadStoredOffers(): Promise<void> {
    const stored = await chrome.storage.local.get(CARD_LINKED_OFFERS_STORAGE_KEY);
    render(stored[CARD_LINKED_OFFERS_STORAGE_KEY]);
  }

  refreshButton.addEventListener("click", async () => {
    setRefreshState(refreshButton, true);
    try {
      await pullOfferUrlCache();
      await loadStoredOffers();
    } finally {
      setRefreshState(refreshButton, false);
    }
  });
  dashboardButton.addEventListener("click", openOffers);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[CARD_LINKED_OFFERS_STORAGE_KEY]) return;
    render(changes[CARD_LINKED_OFFERS_STORAGE_KEY].newValue);
  });

  await loadStoredOffers();
  void pullOfferUrlCache();
}
