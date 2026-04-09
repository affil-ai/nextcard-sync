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
