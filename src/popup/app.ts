import type {
  NextCardAuth,
  ProviderId,
  ProviderStateMap,
  ProviderSyncState,
} from "../lib/types";
import { coreViews, homeElements, authElements, views, onboardingElements, consentElements, footerElements } from "./dom";
import { createAirlineRenderers } from "./renderers/airlines";
import { createBankRenderers } from "./renderers/banks";
import { createHotelRenderers } from "./renderers/hotels";
import { openWallet, updateWalletBtn } from "./renderers/shared";
import {
  DEBUG_FORCE_ONBOARDING,
  loadInitialPopupState,
  loadOnboardingFlags,
  pollPopupSnapshot,
  startProviderSync,
  subscribeToOnboardingFlags,
} from "./state";
import { createConsentController, createOnboardingController } from "./onboarding";
import { createHomeRenderer, populateOnboardingProviders } from "./home/render-home";

type ViewName = keyof typeof views;

// ── Tab switching ──────────────────────────────────────────
const tabBar = document.getElementById("tabBar");
const syncTabPanel = document.getElementById("syncTabPanel");
const toolsTabPanel = document.getElementById("toolsTabPanel");

if (tabBar) {
  tabBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-tab]") as HTMLElement | null;
    if (!btn) return;
    const tab = btn.getAttribute("data-tab");
    tabBar.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    tabBar.setAttribute("data-active", tab ?? "sync");
    if (syncTabPanel) syncTabPanel.style.display = tab === "sync" ? "" : "none";
    if (toolsTabPanel) toolsTabPanel.style.display = tab === "tools" ? "" : "none";
  });
}

// ── Amex Offers ────────────────────────────────────────────
// Set the Amex Offers icon
const amexOffersIcon = document.getElementById("amexOffersIcon") as HTMLImageElement | null;
if (amexOffersIcon) amexOffersIcon.src = chrome.runtime.getURL("src/icons/amex-36.png");

function initAmexOffers() {
  const states = ["Initial", "Loading", "Ready", "Running", "Done", "Error"] as const;
  const panels = Object.fromEntries(states.map((s) => [s, document.getElementById(`amexOffers${s}`)]));

  function showState(state: typeof states[number]) {
    for (const [key, el] of Object.entries(panels)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  let amexCards: Array<{ id: string; name: string; lastDigits: string | null; locale: string; accountKey: string | null }> = [];
  let selectedCardId = "";
  let selectedLocale = "en_US";
  let selectedAccountKey: string | null = null;
  let amexTabId: number | null = null;

  const discoverBtn = document.getElementById("amexOffersDiscoverBtn");
  const runBtn = document.getElementById("amexOffersRunBtn");
  const stopBtn = document.getElementById("amexOffersStopBtn");
  const runAgainBtn = document.getElementById("amexOffersRunAgainBtn");
  const retryBtn = document.getElementById("amexOffersRetryBtn");
  const cardSelect = document.getElementById("amexOffersCardSelect") as HTMLSelectElement | null;
  const cardSelectWrap = document.getElementById("amexOffersCardSelectWrap");
  const offerCountEl = document.getElementById("amexOffersOfferCount");
  const progressBar = document.getElementById("amexOffersProgressBar");
  const progressDetail = document.getElementById("amexOffersProgressDetail");
  const summaryEl = document.getElementById("amexOffersSummary");
  const errorMsgEl = document.getElementById("amexOffersErrorMsg");

  function findOrOpenAmexTab(callback: (tabId: number) => void) {
    // Always open a fresh tab to guarantee the content script hooks.
    // The content script fetches /dashboard itself for card data, so
    // the tab just needs to be on any americanexpress.com page.
    chrome.tabs.create({ url: "https://global.americanexpress.com/offers", active: true }, (newTab) => {
      if (!newTab?.id) {
        if (errorMsgEl) errorMsgEl.textContent = "Could not open Amex tab.";
        showState("Error");
        return;
      }
      const tabId = newTab.id;
      const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          // Give the content script time to initialize
          setTimeout(() => callback(tabId), 3000);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  function tryDiscoverOffers(tabId: number, retriesLeft = 3) {
    chrome.tabs.sendMessage(tabId, { type: "AMEX_OFFERS_DISCOVER" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) {
          // Content script may not be ready yet — retry after a short wait
          setTimeout(() => tryDiscoverOffers(tabId, retriesLeft - 1), 2000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Amex page. Make sure you're signed in.";
        showState("Error");
        return;
      }

      if (resp.error === "no_cards") {
        if (errorMsgEl) errorMsgEl.textContent = "No Amex cards found. Sign in to americanexpress.com and try again.";
        showState("Error");
        return;
      }
      amexCards = resp.cards ?? [];
      if (amexCards.length > 0 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = amexCards.map((c) => `<option value="${c.id}" data-locale="${c.locale}">${c.name}</option>`).join("");
        cardSelectWrap.style.display = "";
      }
      selectedCardId = amexCards[0]?.id ?? "";
      selectedLocale = amexCards[0]?.locale ?? "en_US";
      selectedAccountKey = amexCards[0]?.accountKey ?? null;
      const count = resp.offerCount ?? 0;
      if (offerCountEl) {
        offerCountEl.textContent = count > 0
          ? `${count} eligible offers`
          : `Found ${amexCards.length} card${amexCards.length === 1 ? "" : "s"} — select one and start`;
      }
      showState("Ready");
    });
  }

  discoverBtn?.addEventListener("click", () => {
    showState("Loading");
    amexTabId = null;
    findOrOpenAmexTab((tabId) => {
      amexTabId = tabId;
      tryDiscoverOffers(tabId);
    });
  });

  cardSelect?.addEventListener("change", () => {
    const card = amexCards.find((c) => c.id === cardSelect.value);
    if (card) {
      selectedCardId = card.id;
      selectedLocale = card.locale;
      selectedAccountKey = card.accountKey;
    }
  });

  runBtn?.addEventListener("click", () => {
    if (!amexTabId) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    if (progressDetail) progressDetail.textContent = "";
    const amexSelectedCard = amexCards.find((c) => c.id === selectedCardId);
    chrome.tabs.sendMessage(amexTabId, { type: "AMEX_OFFERS_RUN", cardId: selectedCardId, locale: selectedLocale, accountKey: selectedAccountKey, cardName: amexSelectedCard?.name ?? "", cardLastDigits: amexSelectedCard?.lastDigits ?? null });
  });

  stopBtn?.addEventListener("click", () => {
    if (!amexTabId) return;
    chrome.tabs.sendMessage(amexTabId, { type: "AMEX_OFFERS_STOP" });
    showState("Done");
    if (summaryEl) summaryEl.textContent = "Cancelled";
  });

  runAgainBtn?.addEventListener("click", () => {
    // Go back to card picker if we have cards, otherwise start fresh
    if (amexCards.length > 0) {
      showState("Ready");
    } else {
      showState("Initial");
    }
  });
  retryBtn?.addEventListener("click", () => showState("Initial"));

  // Listen for progress + completion messages from the content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "AMEX_OFFERS_PROGRESS") {
      const added = msg.added ?? 0;
      const skipped = msg.skipped ?? 0;
      const failed = msg.failed ?? 0;
      const total = msg.total ?? 0;
      const round = msg.round ?? 1;
      const done = added + skipped + failed;
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

      if (msg.status === "fetching") {
        if (progressBar) progressBar.style.width = "0%";
        if (progressDetail) progressDetail.textContent = round > 1 ? `Round ${round}: checking for new offers...` : "Fetching offers...";
      } else if (msg.status === "checking_new") {
        if (progressBar) progressBar.style.width = "100%";
        if (progressDetail) progressDetail.textContent = `${added} added so far — checking for new offers...`;
      } else {
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (progressDetail) progressDetail.textContent = `${added} of ${total} added`;
      }
    }
    if (msg.type === "AMEX_OFFERS_COMPLETE") {
      const parts: string[] = [];
      if (msg.added > 0) parts.push(`${msg.added} offer${msg.added === 1 ? "" : "s"} added`);
      if (msg.added === 0) parts.push("No new offers to add");
      if (msg.rounds > 1) parts.push(`${msg.rounds} rounds`);
      if (summaryEl) summaryEl.textContent = parts.join(" · ");
      showState("Done");
    }
  });
}

initAmexOffers();

// ── Chase Offers ──────────────────────────────────────────

function initChaseOffers() {
  const icon = document.getElementById("chaseOffersIcon") as HTMLImageElement | null;
  if (icon) icon.src = chrome.runtime.getURL("src/icons/chase-36.png");

  const states = {
    Initial: document.getElementById("chaseOffersInitial"),
    Loading: document.getElementById("chaseOffersLoading"),
    Ready: document.getElementById("chaseOffersReady"),
    Running: document.getElementById("chaseOffersRunning"),
    Done: document.getElementById("chaseOffersDone"),
    Error: document.getElementById("chaseOffersError"),
  };
  const cardSelect = document.getElementById("chaseOffersCardSelect") as HTMLSelectElement | null;
  const cardSelectWrap = document.getElementById("chaseOffersCardSelectWrap");
  const offerCountEl = document.getElementById("chaseOffersOfferCount");
  const progressBar = document.getElementById("chaseOffersProgressBar") as HTMLDivElement | null;
  const progressDetail = document.getElementById("chaseOffersProgressDetail");
  const summaryEl = document.getElementById("chaseOffersSummary");
  const errorMsgEl = document.getElementById("chaseOffersErrorMsg");

  let chaseCards: Array<{ id: string; name: string; lastDigits: string | null }> = [];
  let chaseTabId: number | null = null;
  let selectedCardId = "";

  function showState(state: keyof typeof states) {
    for (const [key, el] of Object.entries(states)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  function findOrOpenChaseTab(callback: (tabId: number) => void) {
    // Find existing Chase tab or open new one
    chrome.tabs.query({ url: ["https://secure.chase.com/*", "https://secure01a.chase.com/*", "https://secure03a.chase.com/*", "https://secure05a.chase.com/*"] }, (tabs) => {
      if (tabs[0]?.id) {
        // Existing tab — reload to ensure content script hooks
        const tabId = tabs[0].id;
        chrome.tabs.update(tabId, { active: true });
        setTimeout(() => callback(tabId), 1000);
        return;
      }
      // Open new tab
      chrome.tabs.create({ url: "https://secure.chase.com/web/auth/dashboard", active: true }, (newTab) => {
        if (!newTab?.id) {
          if (errorMsgEl) errorMsgEl.textContent = "Could not open Chase tab.";
          showState("Error");
          return;
        }
        const tabId = newTab.id;
        const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(() => callback(tabId), 3000);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  }

  function tryDiscover(tabId: number, retriesLeft = 10) {
    chrome.tabs.sendMessage(tabId, { type: "CHASE_OFFERS_DISCOVER" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) {
          setTimeout(() => tryDiscover(tabId, retriesLeft - 1), 3000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Chase. Make sure you're signed in.";
        showState("Error");
        return;
      }
      if (resp.error === "no_cards") {
        if (errorMsgEl) errorMsgEl.textContent = "No Chase cards found. Sign in and try again.";
        showState("Error");
        return;
      }
      chaseCards = resp.cards ?? [];
      if (chaseCards.length > 1 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = chaseCards.map((c) => `<option value="${c.id}">${c.name}${c.lastDigits ? ` ···· ${c.lastDigits}` : ""}</option>`).join("");
        cardSelectWrap.style.display = "";
      }
      selectedCardId = chaseCards[0]?.id ?? "";
      if (offerCountEl) offerCountEl.textContent = `Found ${chaseCards.length} card${chaseCards.length === 1 ? "" : "s"} — select one and start`;
      showState("Ready");
    });
  }

  document.getElementById("chaseOffersDiscoverBtn")?.addEventListener("click", () => {
    showState("Loading");
    chaseTabId = null;
    findOrOpenChaseTab((tabId) => {
      chaseTabId = tabId;
      tryDiscover(tabId);
    });
  });

  cardSelect?.addEventListener("change", () => {
    const card = chaseCards.find((c) => c.id === cardSelect.value);
    if (card) selectedCardId = card.id;
  });

  document.getElementById("chaseOffersRunBtn")?.addEventListener("click", () => {
    if (!chaseTabId) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    if (progressDetail) progressDetail.textContent = "";
    const allCardIds = chaseCards.map((c) => c.id);
    const chaseSelectedCard = chaseCards.find((c) => c.id === selectedCardId);
    chrome.tabs.sendMessage(chaseTabId, { type: "CHASE_OFFERS_RUN", cardId: selectedCardId, allCardIds, cardName: chaseSelectedCard?.name ?? "", cardLastDigits: chaseSelectedCard?.lastDigits ?? null });
  });

  document.getElementById("chaseOffersStopBtn")?.addEventListener("click", () => {
    if (!chaseTabId) return;
    chrome.tabs.sendMessage(chaseTabId, { type: "CHASE_OFFERS_STOP" });
    showState("Done");
    if (summaryEl) summaryEl.textContent = "Cancelled";
  });

  document.getElementById("chaseOffersRunAgainBtn")?.addEventListener("click", () => {
    if (chaseCards.length > 0) showState("Ready");
    else showState("Initial");
  });
  document.getElementById("chaseOffersRetryBtn")?.addEventListener("click", () => showState("Initial"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CHASE_OFFERS_PROGRESS") {
      const added = msg.added ?? 0;
      const total = msg.total ?? 0;
      const pct = total > 0 ? Math.min(100, Math.round((added / total) * 100)) : 0;
      if (progressBar) progressBar.style.width = `${pct}%`;
      if (progressDetail) progressDetail.textContent = `${added} added`;
    }
    if (msg.type === "CHASE_OFFERS_COMPLETE") {
      const parts: string[] = [];
      if (msg.added > 0) parts.push(`${msg.added} offer${msg.added === 1 ? "" : "s"} added`);
      if (msg.added === 0) parts.push("No new offers to add");
      if (summaryEl) summaryEl.textContent = parts.join(" · ");
      showState("Done");
    }
  });
}

initChaseOffers();

// ── Citi Offers ───────────────────────────────────────────

function initCitiOffers() {
  const icon = document.getElementById("citiOffersIcon") as HTMLImageElement | null;
  if (icon) icon.src = chrome.runtime.getURL("src/icons/citi-36.png");

  const states = {
    Initial: document.getElementById("citiOffersInitial"),
    Loading: document.getElementById("citiOffersLoading"),
    Ready: document.getElementById("citiOffersReady"),
    Running: document.getElementById("citiOffersRunning"),
    Done: document.getElementById("citiOffersDone"),
    Error: document.getElementById("citiOffersError"),
  };
  const cardSelect = document.getElementById("citiOffersCardSelect") as HTMLSelectElement | null;
  const cardSelectWrap = document.getElementById("citiOffersCardSelectWrap");
  const offerCountEl = document.getElementById("citiOffersOfferCount");
  const progressBar = document.getElementById("citiOffersProgressBar") as HTMLDivElement | null;
  const progressDetail = document.getElementById("citiOffersProgressDetail");
  const summaryEl = document.getElementById("citiOffersSummary");
  const errorMsgEl = document.getElementById("citiOffersErrorMsg");

  let citiCards: Array<{ id: string; name: string; lastDigits: string | null }> = [];
  let citiTabId: number | null = null;
  let selectedAccountId = "";

  function showState(state: keyof typeof states) {
    for (const [key, el] of Object.entries(states)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  function findOrOpenCitiTab(callback: (tabId: number) => void) {
    chrome.tabs.create({ url: "https://online.citi.com/US/ag/products-offers/merchantoffers", active: true }, (newTab) => {
      if (!newTab?.id) { if (errorMsgEl) errorMsgEl.textContent = "Could not open Citi tab."; showState("Error"); return; }
      const tabId = newTab.id;
      const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(() => callback(tabId), 3000);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }

  function tryDiscover(tabId: number, retriesLeft = 10) {
    chrome.tabs.sendMessage(tabId, { type: "CITI_OFFERS_DISCOVER" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) { setTimeout(() => tryDiscover(tabId, retriesLeft - 1), 3000); return; }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Citi. Make sure you're signed in.";
        showState("Error");
        return;
      }
      if (resp.error === "no_cards") {
        if (errorMsgEl) errorMsgEl.textContent = "No Citi cards found. Sign in and try again.";
        showState("Error");
        return;
      }
      citiCards = resp.cards ?? [];
      if (citiCards.length > 1 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = citiCards.map((c) => `<option value="${c.id}">${c.name}${c.lastDigits ? ` ···· ${c.lastDigits}` : ""}</option>`).join("");
        cardSelectWrap.style.display = "";
      }
      selectedAccountId = citiCards[0]?.id ?? "";
      if (offerCountEl) offerCountEl.textContent = `Found ${citiCards.length} card${citiCards.length === 1 ? "" : "s"} — select one and start`;
      showState("Ready");
    });
  }

  document.getElementById("citiOffersDiscoverBtn")?.addEventListener("click", () => {
    showState("Loading");
    citiTabId = null;
    findOrOpenCitiTab((tabId) => { citiTabId = tabId; tryDiscover(tabId); });
  });

  cardSelect?.addEventListener("change", () => {
    const card = citiCards.find((c) => c.id === cardSelect.value);
    if (card) selectedAccountId = card.id;
  });

  document.getElementById("citiOffersRunBtn")?.addEventListener("click", () => {
    if (!citiTabId) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    const citiSelectedCard = citiCards.find((c) => c.id === selectedAccountId);
    chrome.tabs.sendMessage(citiTabId, { type: "CITI_OFFERS_RUN", accountId: selectedAccountId, cardName: citiSelectedCard?.name ?? "", cardLastDigits: citiSelectedCard?.lastDigits ?? null });
  });

  document.getElementById("citiOffersStopBtn")?.addEventListener("click", () => {
    if (!citiTabId) return;
    chrome.tabs.sendMessage(citiTabId, { type: "CITI_OFFERS_STOP" });
    showState("Done");
    if (summaryEl) summaryEl.textContent = "Cancelled";
  });

  document.getElementById("citiOffersRunAgainBtn")?.addEventListener("click", () => {
    if (citiCards.length > 0) showState("Ready");
    else showState("Initial");
  });
  document.getElementById("citiOffersRetryBtn")?.addEventListener("click", () => showState("Initial"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CITI_OFFERS_PROGRESS") {
      const added = msg.added ?? 0;
      const total = msg.total ?? 0;
      const pct = total > 0 ? Math.min(100, Math.round((added / total) * 100)) : 0;
      if (progressBar) progressBar.style.width = `${pct}%`;
      if (progressDetail) progressDetail.textContent = `${added} added`;
    }
    if (msg.type === "CITI_OFFERS_COMPLETE") {
      const parts: string[] = [];
      if (msg.added > 0) parts.push(`${msg.added} offer${msg.added === 1 ? "" : "s"} added`);
      if (msg.added === 0) parts.push("No new offers to add");
      if (summaryEl) summaryEl.textContent = parts.join(" · ");
      showState("Done");
    }
  });
}

initCitiOffers();

// ── Discover 5% Bonus ─────────────────────────────────────

function initDiscoverBonus() {
  const icon = document.getElementById("discoverBonusIcon") as HTMLImageElement | null;
  if (icon) icon.src = chrome.runtime.getURL("src/icons/discover-36.png");

  const states = {
    Initial: document.getElementById("discoverBonusInitial"),
    Loading: document.getElementById("discoverBonusLoading"),
    Done: document.getElementById("discoverBonusDone"),
    Error: document.getElementById("discoverBonusError"),
  };
  const resultEl = document.getElementById("discoverBonusResult");
  const errorMsgEl = document.getElementById("discoverBonusErrorMsg");

  let discoverTabId: number | null = null;

  function showState(state: keyof typeof states) {
    for (const [key, el] of Object.entries(states)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  function tryActivate(tabId: number, retriesLeft = 10) {
    chrome.tabs.sendMessage(tabId, { type: "DISCOVER_BONUS_ACTIVATE" }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) {
          setTimeout(() => tryActivate(tabId, retriesLeft - 1), 3000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Discover. Make sure you're signed in.";
        showState("Error");
        return;
      }

      if (resp.error) {
        if (errorMsgEl) errorMsgEl.textContent = resp.error;
        showState("Error");
        return;
      }

      if (resultEl) {
        resultEl.textContent = resp.alreadyActive
          ? "Already activated!"
          : "5% bonus activated!";
      }
      showState("Done");
    });
  }

  document.getElementById("discoverBonusBtn")?.addEventListener("click", () => {
    showState("Loading");
    chrome.tabs.create({ url: "https://www.discover.com/login/", active: true }, (newTab) => {
      if (!newTab?.id) { showState("Error"); return; }
      discoverTabId = newTab.id;

      const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
        if (updatedTabId !== discoverTabId || info.status !== "complete") return;
        const url = tab.url ?? "";

        // Logged in — landed on dashboard or any card.discover.com page
        if (url.includes("card.discover.com")) {
          chrome.tabs.onUpdated.removeListener(listener);
          // Navigate to the 5% bonus page
          chrome.tabs.update(discoverTabId!, { url: "https://card.discover.com/web/rewards/5percent/" });

          // Wait for the bonus page to load, then activate
          const bonusListener = (id: number, bonusInfo: chrome.tabs.TabChangeInfo) => {
            if (id !== discoverTabId || bonusInfo.status !== "complete") return;
            chrome.tabs.onUpdated.removeListener(bonusListener);
            setTimeout(() => tryActivate(discoverTabId!, 10), 3000);
          };
          chrome.tabs.onUpdated.addListener(bonusListener);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      // Timeout after 2 min
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
      }, 120000);
    });
  });

  document.getElementById("discoverBonusAgainBtn")?.addEventListener("click", () => showState("Initial"));
  document.getElementById("discoverBonusRetryBtn")?.addEventListener("click", () => showState("Initial"));
}

initDiscoverBonus();

// ── Chase Bonus Registration ──────────────────────────────

function initChaseBonusRegistration() {
  const icon = document.getElementById("chaseBonusIcon") as HTMLImageElement | null;
  if (icon) icon.src = chrome.runtime.getURL("src/icons/chase-36.png");

  const states = {
    NeedSync: document.getElementById("chaseBonusNeedSync"),
    Initial: document.getElementById("chaseBonusInitial"),
    Running: document.getElementById("chaseBonusRunning"),
    Done: document.getElementById("chaseBonusDone"),
    Error: document.getElementById("chaseBonusError"),
  };
  const lastNameInput = document.getElementById("chaseBonusLastName") as HTMLInputElement | null;
  const zipInput = document.getElementById("chaseBonusZip") as HTMLInputElement | null;
  const errorMsgEl = document.getElementById("chaseBonusErrorMsg");

  function showState(state: keyof typeof states) {
    for (const [key, el] of Object.entries(states)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  // Check if Chase cards are synced
  chrome.storage.local.get("provider_chase", (data) => {
    const chaseData = data.provider_chase;
    if (!chaseData?.data || !chaseData.lastSyncedAt) {
      showState("NeedSync");
    } else {
      // Pre-fill saved values
      chrome.storage.local.get(["nc_bonus_lastName", "nc_bonus_zip"], (saved) => {
        if (lastNameInput && saved.nc_bonus_lastName) lastNameInput.value = saved.nc_bonus_lastName;
        if (zipInput && saved.nc_bonus_zip) zipInput.value = saved.nc_bonus_zip;
      });
      showState("Initial");
    }
  });

  document.getElementById("chaseBonusRegisterBtn")?.addEventListener("click", () => {
    const lastName = lastNameInput?.value.trim() ?? "";
    const zip = zipInput?.value.trim() ?? "";

    if (!lastName || !zip) {
      if (errorMsgEl) errorMsgEl.textContent = "Please enter your last name and zip code.";
      showState("Error");
      return;
    }

    // Save for next time
    chrome.storage.local.set({ nc_bonus_lastName: lastName, nc_bonus_zip: zip });

    showState("Running");

    // Get synced Chase cards
    chrome.storage.local.get("provider_chase", (data) => {
      const chaseData = data.provider_chase?.data;
      if (!chaseData) {
        if (errorMsgEl) errorMsgEl.textContent = "No Chase card data found. Sync your cards first.";
        showState("Error");
        return;
      }

      // Extract last 4 digits from synced cards
      const cards: string[] = [];
      if (chaseData._allCards) {
        for (const card of chaseData._allCards) {
          if (card.lastFourDigits) cards.push(card.lastFourDigits);
        }
      } else if (chaseData.lastFourDigits) {
        cards.push(chaseData.lastFourDigits);
      }

      if (cards.length === 0) {
        if (errorMsgEl) errorMsgEl.textContent = "No card numbers found in synced data. Try syncing Chase again.";
        showState("Error");
        return;
      }

      // Send to service worker
      chrome.runtime.sendMessage({
        type: "CHASE_BONUS_ENROLL",
        cards,
        lastName,
        zip,
      }, (resp) => {
        if (chrome.runtime.lastError || !resp || resp.error) {
          if (errorMsgEl) errorMsgEl.textContent = resp?.error ?? "Registration failed. Try again.";
          showState("Error");
          return;
        }
        showState("Done");
      });
    });
  });

  document.getElementById("chaseBonusAgainBtn")?.addEventListener("click", () => showState("Initial"));
  document.getElementById("chaseBonusRetryBtn")?.addEventListener("click", () => showState("Initial"));
}

initChaseBonusRegistration();

let currentView: ViewName = "disclosure";
let disclosureAccepted = false;
let consentGiven = false;
let firstSyncCompleted = false;
let flagsLoaded = false;
let tourSyncProvider: ProviderId | null = null;

const iconUrl = chrome.runtime.getURL("src/icons/icon128.png");
authElements.authLogo.src = iconUrl;
authElements.disclosureLogo.src = iconUrl;

function showView(name: ViewName) {
  for (const [key, element] of Object.entries(views)) {
    element.classList.toggle("active", key === name);
  }
  currentView = name;
}

for (const button of document.querySelectorAll("[data-back]")) {
  button.addEventListener("click", () => showView("home"));
}

for (const button of document.querySelectorAll(".wallet-btn")) {
  button.addEventListener("click", () => openWallet());
}

homeElements.congratsBtn.addEventListener("click", () => {
  homeElements.congratsBanner.classList.remove("visible");
  showView("home");
});

const hotelRenderers = createHotelRenderers(requestSync);
const airlineRenderers = createAirlineRenderers(requestSync);
const bankRenderers = createBankRenderers(requestSync);

function renderAllProviders(allStates: ProviderStateMap) {
  hotelRenderers.renderMarriott(allStates.marriott);
  airlineRenderers.renderAtmos(allStates.atmos);
  bankRenderers.renderChase(allStates.chase);
  airlineRenderers.renderAA(allStates.aa);
  airlineRenderers.renderDelta(allStates.delta);
  airlineRenderers.renderUnited(allStates.united);
  airlineRenderers.renderSouthwest(allStates.southwest);
  hotelRenderers.renderIhg(allStates.ihg);
  hotelRenderers.renderHyatt(allStates.hyatt);
  bankRenderers.renderAmex(allStates.amex);
  bankRenderers.renderCapitalOne(allStates.capitalone);
  hotelRenderers.renderHilton(allStates.hilton);
  airlineRenderers.renderFrontier(allStates.frontier);
  bankRenderers.renderBilt(allStates.bilt);
  bankRenderers.renderDiscover(allStates.discover);
  bankRenderers.renderCiti(allStates.citi);
}

const onboardingController = createOnboardingController({
  onboardingBtn: onboardingElements.onboardingBtn,
  onComplete: () => {
    disclosureAccepted = true;
    chrome.storage.local.set({ disclosureAccepted: true });
    chrome.runtime.sendMessage({ type: "SIGN_IN_NEXTCARD" });
  },
});

async function recordConsent() {
  chrome.runtime.sendMessage({
    type: "RECORD_CONSENT",
    consentType: "sync_privacy_v1",
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
  });
}

async function startSyncFlow(
  providerId: ProviderId,
  options: { showViewOnStart: boolean },
) {
  if (!firstSyncCompleted) {
    tourSyncProvider = providerId;
  }

  const started = await startProviderSync(providerId);
  if (started && options.showViewOnStart) {
    showView(providerId);
  }

  return started;
}

const consentController = createConsentController({
  ...consentElements,
  onContinue: (providerId) => {
    consentGiven = true;
    chrome.storage.local.set({ consentGiven: true });
    void recordConsent();
    void startSyncFlow(providerId, { showViewOnStart: true });
  },
});

async function requestSync(providerId: ProviderId) {
  if (!consentGiven || DEBUG_FORCE_ONBOARDING) {
    consentController.request(providerId);
    return false;
  }

  return startSyncFlow(providerId, { showViewOnStart: false });
}

function handleProviderSelected(providerId: ProviderId) {
  if (!firstSyncCompleted) {
    void requestSync(providerId);
    return;
  }

  showView(providerId);
}

const renderHome = createHomeRenderer({
  providerList: homeElements.providerList,
  tourTooltip: homeElements.tourTooltip,
  getFirstSyncCompleted: () => firstSyncCompleted,
  markFirstSyncCompleted: () => {
    firstSyncCompleted = true;
    if (!DEBUG_FORCE_ONBOARDING) {
      chrome.storage.local.set({ firstSyncCompleted: true });
    }
  },
  onProviderSelected: handleProviderSelected,
});

populateOnboardingProviders(homeElements.onboardingProviders);

function getInitials(name: string | null) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function renderAuthState(auth: NextCardAuth | null) {
  if (!flagsLoaded) return;

  if (!auth) {
    if (currentView !== "disclosure") {
      showView("disclosure");
    }
    return;
  }

  if (!disclosureAccepted) {
    if (currentView !== "disclosure") {
      showView("disclosure");
    }
    return;
  }

  authElements.userAvatar.textContent = getInitials(auth.name);
  authElements.userName.textContent = auth.name ?? "nextcard user";
  authElements.userEmail.textContent = auth.email ?? "";

  // Show tab bar when signed in
  if (tabBar) tabBar.classList.remove("hidden");

  if (currentView === "auth" || currentView === "disclosure") {
    showView("home");
  }
}

authElements.authSignInBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SIGN_IN_NEXTCARD" });
});

authElements.userSignOutBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SIGN_OUT_NEXTCARD" }, () => {
    disclosureAccepted = false;
    consentGiven = false;
    firstSyncCompleted = false;
    chrome.storage.local.remove([
      "disclosureAccepted",
      "consentGiven",
      "firstSyncCompleted",
      "getStartedShown",
    ]);
    onboardingController.reset();
    showView("disclosure");
  });
});

function maybeShowCongratsBanner(allStates: Record<ProviderId, ProviderSyncState>) {
  if (!tourSyncProvider || allStates[tourSyncProvider]?.status !== "done") {
    return;
  }

  const providerId = tourSyncProvider;
  tourSyncProvider = null;
  firstSyncCompleted = true;
  if (!DEBUG_FORCE_ONBOARDING) {
    chrome.storage.local.set({ firstSyncCompleted: true });
  }
  showView(providerId);
  homeElements.congratsBanner.classList.add("visible");
}

function updateActiveWalletButton(allStates: Record<ProviderId, ProviderSyncState>) {
  if (currentView === "home" || currentView === "auth" || currentView === "disclosure") {
    return;
  }

  updateWalletBtn(currentView, allStates[currentView]?.status ?? "idle");
}

document.addEventListener(
  "wheel",
  (event) => {
    const target = (event.target as HTMLElement).closest(".details-content");
    if (!target) return;
    const element = target as HTMLElement;
    const atTop = element.scrollTop <= 0 && event.deltaY < 0;
    const atBottom =
      element.scrollTop + element.clientHeight >= element.scrollHeight
      && event.deltaY > 0;
    if (atTop || atBottom) {
      event.preventDefault();
    }
  },
  { passive: false },
);

footerElements.versionFooter.innerHTML = `v${chrome.runtime.getManifest().version} <span style="opacity:0.7">· changelog</span>`;
footerElements.versionFooter.addEventListener("click", () => {
  footerElements.changelog.classList.toggle("visible");
});

async function refreshPopupState() {
  try {
    const snapshot = await pollPopupSnapshot();
    renderAuthState(snapshot.auth);
    if (!snapshot.auth || !snapshot.allStates) return;

    renderHome(snapshot.allStates);
    renderAllProviders(snapshot.allStates);
    updateActiveWalletButton(snapshot.allStates);
    maybeShowCongratsBanner(snapshot.allStates);
  } catch {
    // The service worker can be asleep when the popup first opens, so polling stays best-effort.
  }
}

async function initializePopup() {
  const [flags, initialSnapshot] = await Promise.all([
    loadOnboardingFlags(),
    loadInitialPopupState(),
  ]);

  disclosureAccepted = flags.disclosureAccepted;
  consentGiven = flags.consentGiven;
  firstSyncCompleted = flags.firstSyncCompleted;
  flagsLoaded = true;

  subscribeToOnboardingFlags((patch) => {
    if (patch.disclosureAccepted != null) disclosureAccepted = patch.disclosureAccepted;
    if (patch.consentGiven != null) consentGiven = patch.consentGiven;
    if (patch.firstSyncCompleted != null) firstSyncCompleted = patch.firstSyncCompleted;
  });

  renderAuthState(initialSnapshot.auth);
  if (initialSnapshot.auth) {
    renderHome(initialSnapshot.allStates);
    renderAllProviders(initialSnapshot.allStates);
    updateActiveWalletButton(initialSnapshot.allStates);
  }

  setInterval(() => {
    void refreshPopupState();
  }, 500);
}

void initializePopup();
