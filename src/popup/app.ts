import type {
  NextCardAuth,
  ProviderId,
  ProviderStateMap,
  ProviderSyncState,
} from "../lib/types";
import { homeElements, authElements, views, onboardingElements, consentElements, footerElements } from "./dom";
import { createAirlineRenderers } from "./renderers/airlines";
import { createBankRenderers } from "./renderers/banks";
import { createHotelRenderers } from "./renderers/hotels";
import { openRewards, openWallet, updateWalletBtn } from "./renderers/shared";
import {
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

  chrome.storage.local.get("pendingTab").then((stored) => {
    if (stored.pendingTab === "tools" && toolsTabPanel && syncTabPanel) {
      tabBar.setAttribute("data-active", "tools");
      tabBar.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-tab") === "tools");
      });
      syncTabPanel.style.display = "none";
      toolsTabPanel.style.display = "";
      chrome.storage.local.remove("pendingTab");
      chrome.action.setBadgeText({ text: "" });
    }
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
  let amexOfferCounts: Record<string, number> = {};
  let selectedCardId = "";
  let selectedLocale = "en_US";
  let selectedAccountKey: string | null = null;
  let amexTabId: number | null = null;
  let amexOurTabId: number | null = null;
  let amexDiscoverGen = 0;

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

  function waitForTabLoad(tabId: number, callback: (tabId: number) => void) {
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => callback(tabId), 3000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  }

  function findOrOpenAmexTab(callback: (tabId: number) => void) {
    chrome.tabs.query({ url: "https://global.americanexpress.com/*" }, (tabs) => {
      if (tabs[0]?.id) {
        const tabId = tabs[0].id;
        amexTabId = tabId;
        amexOurTabId = null;
        chrome.tabs.update(tabId, { active: true });
        chrome.tabs.reload(tabId);
        waitForTabLoad(tabId, callback);
        return;
      }
      chrome.tabs.create({ url: "https://global.americanexpress.com/offers", active: true }, (newTab) => {
        if (!newTab?.id) {
          if (errorMsgEl) errorMsgEl.textContent = "Could not open Amex tab.";
          showState("Error");
          return;
        }
        amexTabId = newTab.id;
        amexOurTabId = newTab.id;
        waitForTabLoad(newTab.id, callback);
      });
    });
  }

  function tryDiscoverOffers(tabId: number, gen: number, retriesLeft = 10) {
    if (gen !== amexDiscoverGen) return;
    chrome.tabs.sendMessage(tabId, { type: "AMEX_OFFERS_DISCOVER" }, (resp) => {
      if (gen !== amexDiscoverGen) return;
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) {
          setTimeout(() => tryDiscoverOffers(tabId, gen, retriesLeft - 1), 2000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Amex page. Make sure you're signed in.";
        showState("Error");
        return;
      }

      if (resp.error === "no_cards") {
        if (retriesLeft > 0) {
          setTimeout(() => tryDiscoverOffers(tabId, gen, retriesLeft - 1), 3000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "No Amex cards found. Make sure you're signed in and try again.";
        showState("Error");
        return;
      }
      amexCards = resp.cards ?? [];
      amexOfferCounts = resp.offerCounts ?? {};
      if (amexCards.length > 0 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = amexCards.map((c) => {
          const n = amexOfferCounts[c.id] ?? 0;
          const suffix = n > 0 ? ` (${n} offers)` : "";
          return `<option value="${c.id}" data-locale="${c.locale}">${c.name}${suffix}</option>`;
        }).join("");
        cardSelectWrap.style.display = "";
      }
      selectedCardId = amexCards[0]?.id ?? "";
      selectedLocale = amexCards[0]?.locale ?? "en_US";
      selectedAccountKey = amexCards[0]?.accountKey ?? null;
      updateOfferCountLabel();
      showState("Ready");
    });
  }

  const amexCard = document.getElementById("amexOffersCard");
  function handleAmexDiscover() {
    const gen = ++amexDiscoverGen;
    showState("Loading");
    amexTabId = null;
    findOrOpenAmexTab((tabId) => {
      if (gen !== amexDiscoverGen) return;
      amexTabId = tabId;
      tryDiscoverOffers(tabId, gen);
    });
  }
  discoverBtn?.addEventListener("click", (e) => { e.stopPropagation(); handleAmexDiscover(); });
  amexCard?.addEventListener("click", () => { if (panels.Initial?.style.display !== "none") handleAmexDiscover(); });
  document.getElementById("amexOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    amexDiscoverGen++;
    showState("Initial");
    if (amexOurTabId) { chrome.tabs.remove(amexOurTabId); }
    amexTabId = null;
    amexOurTabId = null;
  });
  document.getElementById("amexOffersRefreshBtn")?.addEventListener("click", () => { if (amexTabId) tryDiscoverOffers(amexTabId, ++amexDiscoverGen); });

  function updateOfferCountLabel() {
    if (!offerCountEl) return;
    const count = amexOfferCounts[selectedCardId] ?? 0;
    offerCountEl.textContent = count > 0
      ? `${count} eligible offer${count === 1 ? "" : "s"}`
      : "No unenrolled offers for this card";
  }

  cardSelect?.addEventListener("change", () => {
    const card = amexCards.find((c) => c.id === cardSelect.value);
    if (card) {
      selectedCardId = card.id;
      selectedLocale = card.locale;
      selectedAccountKey = card.accountKey;
      updateOfferCountLabel();
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
  let chaseOfferCounts: Record<string, number> = {};
  let chaseTabId: number | null = null;
  let chaseOurTabId: number | null = null;
  let selectedCardId = "";
  let chaseDiscoverGen = 0;

  function showState(state: keyof typeof states) {
    for (const [key, el] of Object.entries(states)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  function waitForChaseTabLoad(tabId: number, callback: (tabId: number) => void) {
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => callback(tabId), 3000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  }

  function findOrOpenChaseTab(callback: (tabId: number) => void) {
    chrome.tabs.query({ url: ["https://secure.chase.com/*", "https://secure01a.chase.com/*", "https://secure03a.chase.com/*", "https://secure05a.chase.com/*"] }, (tabs) => {
      if (tabs[0]?.id) {
        const tabId = tabs[0].id;
        chaseTabId = tabId;
        chaseOurTabId = null;
        chrome.tabs.update(tabId, { active: true });
        chrome.tabs.reload(tabId);
        waitForChaseTabLoad(tabId, callback);
        return;
      }
      chrome.tabs.create({ url: "https://secure.chase.com/web/auth/dashboard", active: true }, (newTab) => {
        if (!newTab?.id) {
          if (errorMsgEl) errorMsgEl.textContent = "Could not open Chase tab.";
          showState("Error");
          return;
        }
        chaseTabId = newTab.id;
        chaseOurTabId = newTab.id;
        waitForChaseTabLoad(newTab.id, callback);
      });
    });
  }

  function tryDiscover(tabId: number, gen: number, retriesLeft = 15) {
    if (gen !== chaseDiscoverGen) return;
    chrome.tabs.sendMessage(tabId, { type: "CHASE_OFFERS_DISCOVER" }, (resp) => {
      if (gen !== chaseDiscoverGen) return;
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) {
          setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Chase. Make sure you're signed in.";
        showState("Error");
        return;
      }
      if (resp.error === "no_cards") {
        if (retriesLeft > 0) {
          setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "No Chase cards found. Sign in and try again.";
        showState("Error");
        return;
      }
      chaseCards = resp.cards ?? [];
      chaseOfferCounts = resp.offerCounts ?? {};
      if (chaseCards.length > 1 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = chaseCards.map((c) => {
          const n = chaseOfferCounts[c.id] ?? 0;
          const suffix = n > 0 ? ` (${n} offers)` : "";
          return `<option value="${c.id}">${c.name}${c.lastDigits ? ` ···· ${c.lastDigits}` : ""}${suffix}</option>`;
        }).join("");
        cardSelectWrap.style.display = "";
      }
      selectedCardId = chaseCards[0]?.id ?? "";
      updateChaseOfferCountLabel();
      showState("Ready");
    });
  }

  const chaseCard = document.getElementById("chaseOffersCard");
  function handleChaseDiscover() {
    const gen = ++chaseDiscoverGen;
    showState("Loading");
    chaseTabId = null;
    findOrOpenChaseTab((tabId) => {
      if (gen !== chaseDiscoverGen) return;
      chaseTabId = tabId;
      tryDiscover(tabId, gen);
    });
  }
  document.getElementById("chaseOffersDiscoverBtn")?.addEventListener("click", (e) => { e.stopPropagation(); handleChaseDiscover(); });
  chaseCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") handleChaseDiscover(); });
  document.getElementById("chaseOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    chaseDiscoverGen++;
    showState("Initial");
    if (chaseOurTabId) { chrome.tabs.remove(chaseOurTabId); }
    chaseTabId = null;
    chaseOurTabId = null;
  });
  document.getElementById("chaseOffersRefreshBtn")?.addEventListener("click", () => { if (chaseTabId) tryDiscover(chaseTabId, ++chaseDiscoverGen); });

  function updateChaseOfferCountLabel() {
    if (!offerCountEl) return;
    const count = chaseOfferCounts[selectedCardId] ?? 0;
    offerCountEl.textContent = count > 0
      ? `${count} eligible offer${count === 1 ? "" : "s"}`
      : "No unenrolled offers for this card";
  }

  cardSelect?.addEventListener("change", () => {
    const card = chaseCards.find((c) => c.id === cardSelect.value);
    if (card) {
      selectedCardId = card.id;
      updateChaseOfferCountLabel();
    }
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
  let citiOfferCounts: Record<string, number> = {};
  let citiTabId: number | null = null;
  let citiOurTabId: number | null = null;
  let selectedAccountId = "";
  let citiDiscoverGen = 0;

  function showState(state: keyof typeof states) {
    for (const [key, el] of Object.entries(states)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  function findOrOpenCitiTab(callback: (tabId: number) => void) {
    chrome.tabs.query({ url: "https://online.citi.com/*" }, (tabs) => {
      if (tabs[0]?.id) {
        const tabId = tabs[0].id;
        citiTabId = tabId;
        citiOurTabId = null;
        chrome.tabs.update(tabId, { active: true, url: "https://online.citi.com/US/ag/products-offers/merchantoffers" });
        const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId === tabId && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(() => callback(tabId), 3000);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        return;
      }
      chrome.tabs.create({ url: "https://online.citi.com/US/ag/dashboard", active: true }, (newTab) => {
        if (!newTab?.id) { if (errorMsgEl) errorMsgEl.textContent = "Could not open Citi tab."; showState("Error"); return; }
        const tabId = newTab.id;
        citiTabId = tabId;
        citiOurTabId = tabId;
        const dashListener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId !== tabId || info.status !== "complete") return;
          chrome.tabs.onUpdated.removeListener(dashListener);
          chrome.tabs.update(tabId, { url: "https://online.citi.com/US/ag/products-offers/merchantoffers" });
          const offersListener = (updatedTabId2: number, info2: chrome.tabs.TabChangeInfo) => {
            if (updatedTabId2 !== tabId || info2.status !== "complete") return;
            chrome.tabs.onUpdated.removeListener(offersListener);
            setTimeout(() => callback(tabId), 3000);
          };
          chrome.tabs.onUpdated.addListener(offersListener);
        };
        chrome.tabs.onUpdated.addListener(dashListener);
      });
    });
  }

  function tryDiscover(tabId: number, gen: number, retriesLeft = 15) {
    if (gen !== citiDiscoverGen) return;
    chrome.tabs.sendMessage(tabId, { type: "CITI_OFFERS_DISCOVER" }, (resp) => {
      if (gen !== citiDiscoverGen) return;
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) { setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000); return; }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Citi. Make sure you're signed in.";
        showState("Error");
        return;
      }
      if (resp.error === "no_cards") {
        if (retriesLeft > 0) { setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000); return; }
        if (errorMsgEl) errorMsgEl.textContent = "No Citi cards found. Sign in and try again.";
        showState("Error");
        return;
      }
      citiCards = resp.cards ?? [];
      citiOfferCounts = resp.offerCounts ?? {};
      if (citiCards.length > 1 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = citiCards.map((c) => {
          const n = citiOfferCounts[c.id] ?? 0;
          const suffix = n > 0 ? ` (${n} offers)` : "";
          return `<option value="${c.id}">${c.name}${c.lastDigits ? ` ···· ${c.lastDigits}` : ""}${suffix}</option>`;
        }).join("");
        cardSelectWrap.style.display = "";
      }
      selectedAccountId = citiCards[0]?.id ?? "";
      updateCitiOfferCountLabel();
      showState("Ready");
    });
  }

  const citiCard = document.getElementById("citiOffersCard");
  function handleCitiDiscover() {
    const gen = ++citiDiscoverGen;
    showState("Loading");
    citiTabId = null;
    findOrOpenCitiTab((tabId) => { if (gen !== citiDiscoverGen) return; citiTabId = tabId; tryDiscover(tabId, gen); });
  }
  document.getElementById("citiOffersDiscoverBtn")?.addEventListener("click", (e) => { e.stopPropagation(); handleCitiDiscover(); });
  citiCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") handleCitiDiscover(); });
  document.getElementById("citiOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    citiDiscoverGen++;
    showState("Initial");
    if (citiOurTabId) { chrome.tabs.remove(citiOurTabId); }
    citiTabId = null;
    citiOurTabId = null;
  });
  document.getElementById("citiOffersRefreshBtn")?.addEventListener("click", () => { if (citiTabId) tryDiscover(citiTabId, ++citiDiscoverGen); });

  function updateCitiOfferCountLabel() {
    if (!offerCountEl) return;
    const count = citiOfferCounts[selectedAccountId] ?? 0;
    offerCountEl.textContent = count > 0
      ? `${count} eligible offer${count === 1 ? "" : "s"}`
      : "No unenrolled offers for this card";
  }

  cardSelect?.addEventListener("change", () => {
    const card = citiCards.find((c) => c.id === cardSelect.value);
    if (card) {
      selectedAccountId = card.id;
      updateCitiOfferCountLabel();
    }
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

// ── Capital One Offers ────────────────────────────────────

function initCapitalOneOffers() {
  const icon = document.getElementById("capitaloneOffersIcon") as HTMLImageElement | null;
  if (icon) icon.src = chrome.runtime.getURL("src/icons/capitalone-36.png");

  const states = {
    Initial: document.getElementById("capitaloneOffersInitial"),
    Loading: document.getElementById("capitaloneOffersLoading"),
    Ready: document.getElementById("capitaloneOffersReady"),
    Running: document.getElementById("capitaloneOffersRunning"),
    Done: document.getElementById("capitaloneOffersDone"),
    Error: document.getElementById("capitaloneOffersError"),
  };
  const cardSelect = document.getElementById("capitaloneOffersCardSelect") as HTMLSelectElement | null;
  const cardSelectWrap = document.getElementById("capitaloneOffersCardSelectWrap");
  const offerCountEl = document.getElementById("capitaloneOffersOfferCount");
  const loadingText = document.getElementById("capitaloneOffersLoadingText");
  const loadingProgressBar = document.getElementById("capitaloneOffersLoadingProgressBar") as HTMLDivElement | null;
  const loadingProgressDetail = document.getElementById("capitaloneOffersLoadingProgressDetail");
  const progressBar = document.getElementById("capitaloneOffersProgressBar") as HTMLDivElement | null;
  const progressDetail = document.getElementById("capitaloneOffersProgressDetail");
  const summaryEl = document.getElementById("capitaloneOffersSummary");
  const errorMsgEl = document.getElementById("capitaloneOffersErrorMsg");

  let capitalOneCards: Array<{ id: string; name: string; lastDigits: string | null }> = [];
  let capitalOneOfferCounts: Record<string, number> = {};
  let capitalOneTabId: number | null = null;
  let capitalOneOurTabId: number | null = null;
  let capitalOneDiscoverGen = 0;

  function showState(state: keyof typeof states) {
    for (const [key, el] of Object.entries(states)) {
      if (el) el.style.display = key === state ? "" : "none";
    }
  }

  function escapeHtml(value: string) {
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function waitForCapitalOneTabLoad(tabId: number, callback: (tabId: number) => void) {
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => callback(tabId), 3000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  }

  function findOrOpenCapitalOneTab(callback: (tabId: number) => void) {
    chrome.tabs.query({ url: ["https://capitaloneoffers.com/*", "https://myaccounts.capitalone.com/*"] }, (tabs) => {
      if (tabs[0]?.id) {
        const tabId = tabs[0].id;
        capitalOneTabId = tabId;
        capitalOneOurTabId = null;
        if (tabs[0].url?.startsWith("https://capitaloneoffers.com/")) {
          chrome.tabs.update(tabId, { active: true }, () => {
            waitForCapitalOneTabLoad(tabId, callback);
            chrome.tabs.reload(tabId);
          });
        } else {
          chrome.tabs.update(tabId, { active: true, url: "https://myaccounts.capitalone.com/accountSummary" });
          waitForCapitalOneTabLoad(tabId, callback);
        }
        return;
      }
      chrome.tabs.create({ url: "https://myaccounts.capitalone.com/accountSummary", active: true }, (newTab) => {
        if (!newTab?.id) { if (errorMsgEl) errorMsgEl.textContent = "Could not open Capital One tab."; showState("Error"); return; }
        capitalOneTabId = newTab.id;
        capitalOneOurTabId = newTab.id;
        waitForCapitalOneTabLoad(newTab.id, callback);
      });
    });
  }

  function totalOfferCount() {
    return Object.values(capitalOneOfferCounts).reduce((sum, count) => sum + count, 0);
  }

  function updateOfferCountLabel() {
    if (!offerCountEl) return;
    const total = totalOfferCount();
    const cardCount = capitalOneCards.length;
    offerCountEl.textContent = total > 0
      ? `${total} offer${total === 1 ? "" : "s"} across ${cardCount} card${cardCount === 1 ? "" : "s"}`
      : "No shopping offers found";
  }

  function updateDoneSummary() {
    if (!summaryEl) return;
    const total = totalOfferCount();
    const cardCount = capitalOneCards.length;
    summaryEl.textContent = total > 0
      ? `${total} offer${total === 1 ? "" : "s"} saved across ${cardCount} card${cardCount === 1 ? "" : "s"}`
      : "No shopping offers found";
  }

  function tryDiscover(tabId: number, gen: number, retriesLeft = 15) {
    if (gen !== capitalOneDiscoverGen) return;
    chrome.tabs.sendMessage(tabId, { type: "CAPITALONE_OFFERS_DISCOVER" }, (resp) => {
      if (gen !== capitalOneDiscoverGen) return;
      if (chrome.runtime.lastError || !resp) {
        if (retriesLeft > 0) { setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000); return; }
        if (errorMsgEl) errorMsgEl.textContent = "Could not reach Capital One. Make sure you're signed in.";
        showState("Error");
        return;
      }
      if (resp.redirectUrl) {
        chrome.tabs.update(tabId, { active: true, url: resp.redirectUrl }, () => {
          waitForCapitalOneTabLoad(tabId, (loadedTabId) => tryDiscover(loadedTabId, gen, retriesLeft));
        });
        return;
      }
      if (resp.error === "no_cards") {
        if (retriesLeft > 0) { setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000); return; }
        if (errorMsgEl) errorMsgEl.textContent = "No eligible Capital One cards found. Sign in and try again.";
        showState("Error");
        return;
      }
      if (resp.error) {
        if (errorMsgEl) errorMsgEl.textContent = "Could not save Capital One offers. Try again in a minute.";
        showState("Error");
        return;
      }

      capitalOneCards = resp.cards ?? [];
      capitalOneOfferCounts = resp.offerCounts ?? {};
      if (cardSelectWrap) cardSelectWrap.style.display = "none";
      if (capitalOneCards.length > 1 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = capitalOneCards.map((card) => {
          const count = capitalOneOfferCounts[card.id] ?? 0;
          const suffix = count > 0 ? ` (${count} offers)` : "";
          const label = `${card.name}${card.lastDigits ? ` ···· ${card.lastDigits}` : ""}${suffix}`;
          return `<option value="${escapeHtml(card.id)}">${escapeHtml(label)}</option>`;
        }).join("");
        cardSelectWrap.style.display = "";
      }
      updateOfferCountLabel();
      if (loadingProgressBar) loadingProgressBar.style.width = "100%";
      if (loadingProgressDetail) loadingProgressDetail.textContent = "Offers saved";
      updateDoneSummary();
      showState("Done");
    });
  }

  const capitalOneCard = document.getElementById("capitaloneOffersCard");
  function handleDiscover() {
    const gen = ++capitalOneDiscoverGen;
    showState("Loading");
    if (loadingText) loadingText.textContent = "Looking for your Capital One offers...";
    if (loadingProgressBar) loadingProgressBar.style.width = "4%";
    if (loadingProgressDetail) loadingProgressDetail.textContent = "Starting...";
    capitalOneTabId = null;
    findOrOpenCapitalOneTab((tabId) => {
      if (gen !== capitalOneDiscoverGen) return;
      capitalOneTabId = tabId;
      tryDiscover(tabId, gen);
    });
  }

  function handleRefresh() {
    const gen = ++capitalOneDiscoverGen;
    showState("Loading");
    if (loadingText) loadingText.textContent = "Refreshing Capital One offers...";
    if (loadingProgressBar) loadingProgressBar.style.width = "4%";
    if (loadingProgressDetail) loadingProgressDetail.textContent = "Starting...";

    if (capitalOneTabId) {
      tryDiscover(capitalOneTabId, gen);
      return;
    }

    findOrOpenCapitalOneTab((tabId) => {
      if (gen !== capitalOneDiscoverGen) return;
      capitalOneTabId = tabId;
      tryDiscover(tabId, gen);
    });
  }

  document.getElementById("capitaloneOffersDiscoverBtn")?.addEventListener("click", (e) => { e.stopPropagation(); handleDiscover(); });
  capitalOneCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") handleDiscover(); });
  document.getElementById("capitaloneOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    capitalOneDiscoverGen++;
    showState("Initial");
    if (capitalOneOurTabId) { chrome.tabs.remove(capitalOneOurTabId); }
    capitalOneTabId = null;
    capitalOneOurTabId = null;
  });
  document.getElementById("capitaloneOffersRefreshBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    handleRefresh();
  });

  document.getElementById("capitaloneOffersRunBtn")?.addEventListener("click", () => {
    if (!capitalOneTabId) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    if (progressDetail) progressDetail.textContent = "Syncing all cards...";
    chrome.tabs.sendMessage(capitalOneTabId, { type: "CAPITALONE_OFFERS_RUN" });
  });

  document.getElementById("capitaloneOffersStopBtn")?.addEventListener("click", () => {
    if (!capitalOneTabId) return;
    chrome.tabs.sendMessage(capitalOneTabId, { type: "CAPITALONE_OFFERS_STOP" });
    showState("Done");
    if (summaryEl) summaryEl.textContent = "Cancelled";
  });

  document.getElementById("capitaloneOffersRunAgainBtn")?.addEventListener("click", () => {
    handleRefresh();
  });
  document.getElementById("capitaloneOffersRetryBtn")?.addEventListener("click", () => showState("Initial"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "CAPITALONE_OFFERS_PROGRESS") {
      if (msg.phase === "discovering") {
        const pct = typeof msg.progress === "number" ? Math.max(4, Math.min(95, msg.progress)) : 12;
        const offersFound = msg.offersFound ?? 0;
        const cardIndex = msg.cardIndex ?? 0;
        const cardTotal = msg.cardTotal ?? 1;
        const page = msg.page ?? 0;
        if (loadingText) loadingText.textContent = "Fetching Capital One offers...";
        if (loadingProgressBar) loadingProgressBar.style.width = `${pct}%`;
        if (loadingProgressDetail) {
          loadingProgressDetail.textContent = typeof msg.statusText === "string"
            ? msg.statusText
            : page > 0
            ? `Card ${Number(cardIndex) + 1} of ${cardTotal} · page ${page} · ${offersFound} offers`
            : "Opening full offers feed...";
        }
      }
      const synced = msg.synced ?? 0;
      const total = msg.total ?? totalOfferCount();
      const pct = total > 0 ? Math.min(100, Math.round((synced / total) * 100)) : 0;
      if (progressBar) progressBar.style.width = `${pct}%`;
      if (progressDetail) progressDetail.textContent = `${synced} synced`;
    }
    if (msg.type === "CAPITALONE_OFFERS_COMPLETE") {
      const synced = msg.synced ?? 0;
      if (summaryEl) summaryEl.textContent = synced > 0
        ? `${synced} offer${synced === 1 ? "" : "s"} synced`
        : "No shopping offers found";
      showState("Done");
    }
  });
}

initCapitalOneOffers();

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

  const discoverCard = document.getElementById("discoverBonusCard");
  function handleDiscoverBonus() {
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
  }
  document.getElementById("discoverBonusBtn")?.addEventListener("click", (e) => { e.stopPropagation(); handleDiscoverBonus(); });
  discoverCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") handleDiscoverBonus(); });

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
  button.addEventListener("click", () => openRewards());
}

document.getElementById("homeWalletBtn")?.addEventListener("click", () => openWallet());

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const reportButton = target.closest("[data-issue-report-mailto]") as HTMLElement | null;
  if (reportButton) {
    event.preventDefault();
    event.stopPropagation();
    const mailto = reportButton.getAttribute("data-issue-report-mailto");
    if (mailto) {
      chrome.tabs.create({ url: mailto });
    }
    return;
  }

  const infoButton = target.closest("[data-info-toggle]") as HTMLButtonElement | null;
  const openPopover = document.querySelector(".info-popover.visible");
  if (!infoButton) {
    openPopover?.classList.remove("visible");
    document
      .querySelectorAll("[data-info-toggle][aria-expanded='true']")
      .forEach((button) => button.setAttribute("aria-expanded", "false"));
    return;
  }

  const popoverId = infoButton.getAttribute("data-info-toggle");
  const popover = popoverId ? document.getElementById(popoverId) : null;
  if (!popover) return;

  const willOpen = !popover.classList.contains("visible");
  document
    .querySelectorAll(".info-popover.visible")
    .forEach((element) => element.classList.remove("visible"));
  document
    .querySelectorAll("[data-info-toggle][aria-expanded='true']")
    .forEach((button) => button.setAttribute("aria-expanded", "false"));

  popover.classList.toggle("visible", willOpen);
  infoButton.setAttribute("aria-expanded", String(willOpen));
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document
    .querySelectorAll(".info-popover.visible")
    .forEach((element) => element.classList.remove("visible"));
  document
    .querySelectorAll("[data-info-toggle][aria-expanded='true']")
    .forEach((button) => button.setAttribute("aria-expanded", "false"));
});

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
  if (!consentGiven) {
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
    chrome.storage.local.set({ firstSyncCompleted: true });
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

let authConfirmed = false;

function renderAuthState(auth: NextCardAuth | null) {
  if (!flagsLoaded) return;

  if (!auth) {
    // Don't flash the disclosure view on first load — service worker may still be waking up.
    // Only show disclosure after a poll confirms auth is truly null.
    if (!authConfirmed) return;
    if (currentView !== "disclosure") {
      showView("disclosure");
    }
    return;
  }
  authConfirmed = true;

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
  chrome.storage.local.set({ firstSyncCompleted: true });
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
    authConfirmed = true;
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
