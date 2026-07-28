import type {
  ExtensionProfile,
  NextCardAuth,
  ProviderId,
  ProviderStateMap,
  ProviderSyncState,
} from "../lib/types";
import {
  getOfferOperationStatusText,
  isOfferOperationActive,
  isOfferResultFresh,
  normalizeOfferOperationSnapshot,
  type OfferIssuer,
  type OfferOperationCard,
  type OfferOperationSnapshot,
} from "../lib/offer-operation";
import { homeElements, authElements, views, onboardingElements, consentElements, footerElements } from "./dom";
import { createAirlineRenderers } from "./renderers/airlines";
import { createBankRenderers } from "./renderers/banks";
import { createHotelRenderers } from "./renderers/hotels";
import { openOffers, openRewards, updateWalletBtn } from "./renderers/shared";
import {
  loadInitialPopupState,
  loadOnboardingFlags,
  pollPopupSnapshot,
  startProviderSync,
  subscribeToOnboardingFlags,
} from "./state";
import { createConsentController, createOnboardingController } from "./onboarding";
import { createHomeRenderer } from "./home/render-home";
import {
  getOffersSetupCompletedStorageKey,
  getOffersSetupState,
  isOffersSetupComplete,
} from "./offers-setup";

type ViewName = keyof typeof views;

// ── Tab switching ──────────────────────────────────────────
const tabBar = document.getElementById("tabBar");
const syncTabPanel = document.getElementById("syncTabPanel");
const toolsTabPanel = document.getElementById("toolsTabPanel");
let offersFirstUiEnabled = false;
let activeDestination: "offers" | "rewards" = "offers";
let offerConsentVersion = 0;
const CURRENT_OFFERS_INTRO_VERSION = 10;
const CURRENT_OFFER_CONSENT_VERSION = 1;
const CURRENT_FULL_FLOW_QA_RESET_VERSION = 1;
const SIGNED_OUT_CONFIRMATION_POLLS = 3;
const NEXTCARD_AUTH_WAIT_TIMEOUT_MS = 45_000;
const OFFER_ACTIVATION_USAGE_REFRESH_MS = 3 * 60 * 1000;
const activeOfferRunIds = new Map<OfferIssuer, string>();
let renderedAccountKey: string | null = null;
let destinationRestored = false;
let offerActivationUsage: {
  used: number;
  limit: number | null;
  remaining: number | null;
  accountLevel: "free" | "pro";
} | null = null;
let offerActivationUsageFetchedAt = 0;
let offerActivationUsageRequest: Promise<void> | null = null;
let offerLimitDialogTrigger: HTMLElement | null = null;

function setDestination(destination: "offers" | "rewards", options: { persist?: boolean } = {}) {
  activeDestination = destination;
  tabBar?.setAttribute("data-active", destination);
  tabBar?.querySelectorAll(".tab-btn").forEach((button) => {
    const selected = button.getAttribute("data-tab") === destination;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.setAttribute("tabindex", selected ? "0" : "-1");
  });
  if (syncTabPanel) syncTabPanel.style.display = destination === "rewards" ? "" : "none";
  if (toolsTabPanel) toolsTabPanel.style.display = destination === "offers" ? "" : "none";
  if (options.persist !== false) {
    void chrome.storage.local.set({ lastHomeDestination: destination });
  }
}

type OfferToolCard = {
  id: string;
  name: string;
  lastDigits: string | null;
};

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatCardDisplayName(
  card: Pick<OfferToolCard, "name" | "lastDigits"> | undefined,
) {
  if (!card) return "this card";
  return `${card.name}${card.lastDigits ? ` ···· ${card.lastDigits}` : ""}`;
}

function formatAvailableToActivate(count: number) {
  return `${count} available to activate`;
}

function findOfferToolCardBySelectValue<T extends { id: string }>(
  cards: T[],
  value: string,
) {
  const directMatch = cards.find((card) => card.id === value);
  if (directMatch) return directMatch;
  const indexMatch = value.match(/^card-(\d+)$/);
  return indexMatch ? cards[Number(indexMatch[1])] : undefined;
}

function renderOfferCardChoices(options: {
  issuer: "amex" | "chase" | "citi";
  cards: OfferToolCard[];
  counts: Record<string, number>;
  select: HTMLSelectElement | null;
  selectWrap: HTMLElement | null;
  runButton: HTMLButtonElement | null;
}) {
  if (!offersFirstUiEnabled || !options.selectWrap || options.cards.length === 0) return;
  let container = document.getElementById(`${options.issuer}OfferCardChoices`);
  if (!container) {
    container = document.createElement("div");
    container.id = `${options.issuer}OfferCardChoices`;
    container.className = "offer-card-choices";
    options.selectWrap.insertAdjacentElement("beforebegin", container);
  }
  container.innerHTML = "";
  options.selectWrap.style.display = "none";

  const selectCard = (cardId: string, button: HTMLButtonElement) => {
    if (options.select) {
      options.select.value = cardId;
      options.select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    container?.querySelectorAll("button").forEach((candidate) => {
      candidate.classList.toggle("selected", candidate === button);
      candidate.setAttribute("aria-pressed", String(candidate === button));
    });
    const count = options.counts[cardId];
    if (options.runButton) {
      options.runButton.textContent =
        typeof count === "number" && count > 0 ? `Add ${count} offers` : "Add offers";
      options.runButton.disabled = count === 0;
    }
  };

  const initialCardId = options.cards.some((card) => card.id === options.select?.value)
    ? options.select?.value
    : options.cards[0]?.id;
  options.cards.forEach((card) => {
    const count = options.counts[card.id];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "offer-card-choice";
    const selected = card.id === initialCardId;
    button.setAttribute("aria-pressed", String(selected));
    button.innerHTML = `
      <span>${escapeHtml(formatCardDisplayName(card))}</span>
      <strong>${typeof count === "number" ? `${count} ${count === 1 ? "offer" : "offers"} found` : "Count unavailable"}</strong>
    `;
    button.addEventListener("click", () => selectCard(card.id, button));
    container?.appendChild(button);
    if (selected) selectCard(card.id, button);
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const offerIssuerNames: Record<OfferIssuer, string> = {
  chase: "Chase",
  amex: "Amex",
  citi: "Citi",
  capitalone: "Capital One",
};

async function patchOfferOperation(
  issuer: OfferIssuer,
  patch: Record<string, unknown>,
) {
  const runId = activeOfferRunIds.get(issuer);
  if (!runId) return;
  await chrome.runtime.sendMessage({
    type: "PATCH_OFFER_OPERATION",
    runId,
    ...patch,
  }).catch(() => null);
}

async function beginTrackedOfferCheck(
  issuer: OfferIssuer,
  action: () => void,
) {
  if (!offersFirstUiEnabled) {
    action();
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "START_OFFER_CHECK",
    issuer,
  }).catch(() => null) as {
    ok?: boolean;
    busy?: OfferIssuer;
    state?: { runId?: string };
  } | null;

  if (!response?.ok || !response.state?.runId) {
    const activeIssuer = response?.busy ? offerIssuerNames[response.busy] : "another issuer";
    renderOfferActivityMessage(
      `Finish or stop ${activeIssuer} first`,
      "Only one card-offer check can run at a time.",
    );
    return;
  }

  activeOfferRunIds.set(issuer, response.state.runId);
  void refreshOfferOperationUi();
}

function requestOfferCheck(issuer: OfferIssuer, action: () => void) {
  const execute = () => void beginTrackedOfferCheck(issuer, action);
  if (offerConsentVersion >= CURRENT_OFFER_CONSENT_VERSION) {
    execute();
    return;
  }

  const issuerName = offerIssuerNames[issuer];
  consentController.requestAction(
    () => {
      void recordOfferConsent().then((recorded) => {
        if (!recorded) {
          renderOfferActivityMessage(
            "Couldn’t save your permission",
            "Check your connection and try again.",
          );
          return;
        }
        offerConsentVersion = CURRENT_OFFER_CONSENT_VERSION;
        void chrome.storage.local.set({
          offerConsentVersion: CURRENT_OFFER_CONSENT_VERSION,
        });
        execute();
      });
    },
    {
      title: `Check ${issuerName} offers?`,
      body: `
        <p><strong>nextcard will read card names and offers visible in your signed-in ${issuerName} account.</strong></p>
        <p>Detected offer details are saved to your nextcard account so they can be tracked and used for shopping reminders. Nothing will be added to ${issuerName} until you confirm.</p>
        <p>We never store your ${issuerName} password or verification codes.</p>
        <p><a href="https://www.nextcard.com/privacy/nextcard-sync" target="_blank" rel="noopener noreferrer">Privacy Policy</a></p>
      `,
      continueLabel: `Agree & open ${issuerName}`,
    },
  );
}

async function startTrackedEnrollment(
  issuer: OfferIssuer,
  selectedCardKeys: string[],
  total: number | null,
  options: { addMatchingOffersAcrossCards?: boolean } = {},
): Promise<"started" | "limit_reached" | "failed"> {
  const runId = activeOfferRunIds.get(issuer);
  if (!runId) return "failed";
  const response = await chrome.runtime.sendMessage({
    type: "START_OFFER_ENROLLMENT",
    runId,
    selectedCardKeys,
    total,
    addMatchingOffersAcrossCards: options.addMatchingOffersAcrossCards === true,
  }).catch(() => null) as {
    ok?: boolean;
    error?: string;
    used?: number;
    limit?: number | null;
    remaining?: number | null;
    accountLevel?: "free" | "pro";
  } | null;
  if (response?.error === "monthly_offer_limit_reached") {
    showOfferLimitDialog(response);
    return "limit_reached";
  }
  if (response?.error === "quota_unavailable") {
    showOfferQuotaUnavailableDialog();
    return "failed";
  }
  if (response?.ok === true) {
    offerActivationUsageFetchedAt = 0;
  }
  return response?.ok === true ? "started" : "failed";
}

async function reserveLegacyEnrollment(requested: number) {
  const runId = crypto.randomUUID();
  const response = await chrome.runtime.sendMessage({
    type: "RESERVE_OFFER_ACTIVATION",
    runId,
    requested,
  }).catch(() => null) as {
    ok?: boolean;
    error?: string;
    granted?: number;
    used?: number;
    limit?: number | null;
    remaining?: number | null;
    accountLevel?: "free" | "pro";
  } | null;
  if (response?.ok !== true || typeof response.granted !== "number") {
    if (response?.error === "monthly_offer_limit_reached") {
      showOfferLimitDialog(response);
    } else {
      showOfferQuotaUnavailableDialog();
    }
    return null;
  }
  return {
    runId,
    maxOffers: Math.max(0, Math.floor(response.granted)),
  };
}

let offerConfirmationTrigger: HTMLButtonElement | null = null;
let amexMultiEnrollDisclaimerTrigger: HTMLButtonElement | null = null;

function closeOfferLimitDialog(options: { restoreFocus: boolean }) {
  const modal = document.getElementById("offerLimitModal");
  modal?.classList.remove("visible");
  modal?.setAttribute("aria-hidden", "true");
  if (options.restoreFocus) offerLimitDialogTrigger?.focus();
  offerLimitDialogTrigger = null;
}

function showOfferLimitDialog(usage?: {
  used?: number;
  limit?: number | null;
  remaining?: number | null;
  accountLevel?: "free" | "pro";
} | null) {
  const modal = document.getElementById("offerLimitModal");
  const body = document.getElementById("offerLimitBody");
  const eyebrow = document.querySelector<HTMLElement>(
    "#offerLimitModal .offers-eyebrow",
  );
  const title = document.getElementById("offerLimitTitle");
  const dismiss = document.getElementById(
    "offerLimitDismiss",
  ) as HTMLButtonElement | null;
  const upgrade = document.getElementById(
    "offerLimitUpgrade",
  ) as HTMLButtonElement | null;
  if (!modal || !body || !title || !upgrade || !dismiss) return;

  if (eyebrow) eyebrow.textContent = "Free plan";
  title.textContent = "Monthly limit reached";
  upgrade.hidden = false;
  dismiss.textContent = "Maybe later";

  if (
    typeof usage?.used === "number"
    && typeof usage.limit === "number"
    && typeof usage.remaining === "number"
  ) {
    offerActivationUsage = {
      used: Math.max(0, usage.used),
      limit: usage.limit,
      remaining: Math.max(0, usage.remaining),
      accountLevel: "free",
    };
    renderOfferActivationUsage();
  }

  const limit =
    typeof usage?.limit === "number"
      ? usage.limit
      : offerActivationUsage?.limit ?? 100;
  body.textContent =
    `You’ve used all ${limit} Free offer activations for this month. `
    + "Your allowance resets next month, or you can upgrade for unlimited activations.";
  offerLimitDialogTrigger =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
  upgrade.focus();
}

function showOfferQuotaUnavailableDialog() {
  const modal = document.getElementById("offerLimitModal");
  const eyebrow = document.querySelector<HTMLElement>(
    "#offerLimitModal .offers-eyebrow",
  );
  const title = document.getElementById("offerLimitTitle");
  const body = document.getElementById("offerLimitBody");
  const upgrade = document.getElementById(
    "offerLimitUpgrade",
  ) as HTMLButtonElement | null;
  const dismiss = document.getElementById(
    "offerLimitDismiss",
  ) as HTMLButtonElement | null;
  if (!modal || !title || !body || !upgrade || !dismiss) return;

  if (eyebrow) eyebrow.textContent = "Please try again";
  title.textContent = "Couldn’t verify your monthly limit";
  body.textContent =
    "No offers were added. Check your connection and try again in a moment.";
  upgrade.hidden = true;
  dismiss.textContent = "Close";
  offerLimitDialogTrigger =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
  dismiss.focus();
}

function closeOfferConfirmation(options: { restoreFocus: boolean }) {
  document.getElementById("offerConfirmModal")?.classList.remove("visible");
  if (options.restoreFocus) offerConfirmationTrigger?.focus();
  offerConfirmationTrigger = null;
}

function closeAmexMultiEnrollDisclaimer(options: { restoreFocus: boolean }) {
  const modal = document.getElementById("amexMultiEnrollDisclaimerModal");
  const checkbox = document.getElementById(
    "amexMultiEnrollDisclaimerCheckbox",
  ) as HTMLInputElement | null;
  const continueButton = document.getElementById(
    "amexMultiEnrollDisclaimerContinue",
  ) as HTMLButtonElement | null;
  modal?.classList.remove("visible");
  modal?.setAttribute("aria-hidden", "true");
  if (checkbox) checkbox.checked = false;
  if (continueButton) continueButton.disabled = true;
  if (options.restoreFocus) amexMultiEnrollDisclaimerTrigger?.focus();
  amexMultiEnrollDisclaimerTrigger = null;
}

function showAmexMultiEnrollDisclaimer(button: HTMLButtonElement) {
  const modal = document.getElementById("amexMultiEnrollDisclaimerModal");
  const checkbox = document.getElementById(
    "amexMultiEnrollDisclaimerCheckbox",
  ) as HTMLInputElement | null;
  const continueButton = document.getElementById(
    "amexMultiEnrollDisclaimerContinue",
  ) as HTMLButtonElement | null;
  if (!modal || !checkbox || !continueButton) return;
  amexMultiEnrollDisclaimerTrigger = button;
  checkbox.checked = false;
  continueButton.disabled = true;
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
  checkbox.focus();
}

function confirmOfferEnrollment(button: HTMLButtonElement) {
  const modal = document.getElementById("offerConfirmModal");
  const title = document.getElementById("offerConfirmTitle");
  const body = document.getElementById("offerConfirmBody");
  const continueButton = document.getElementById("offerConfirmContinue") as HTMLButtonElement | null;
  if (!modal || !title || !body || !continueButton) return;

  const config = {
    chaseOffersRunBtn: {
      issuer: "Chase",
      selectId: "chaseOffersCardSelect",
      countId: "chaseOffersOfferCount",
    },
    amexOffersRunBtn: {
      issuer: "Amex",
      selectId: "amexOffersCardSelect",
      countId: "amexOffersOfferCount",
    },
    citiOffersRunBtn: {
      issuer: "Citi",
      selectId: "citiOffersCardSelect",
      countId: "citiOffersOfferCount",
    },
  }[button.id];
  if (!config) return;

  const select = document.getElementById(config.selectId) as HTMLSelectElement | null;
  const selectedLabel = select?.selectedOptions[0]?.textContent
    ?.replace(/\s*\(\d+ available to activate\)\s*$/, "")
    .trim();
  const count = button.dataset.enrollmentCount ?? null;
  const amexShared =
    button.id === "amexOffersRunBtn"
    && (document.getElementById("amexOffersSharedCheckbox") as HTMLInputElement | null)?.checked;
  if (amexShared && button.dataset.sharedRiskAcknowledged !== "true") {
    showAmexMultiEnrollDisclaimer(button);
    return;
  }

  title.textContent =
    count && selectedLabel && !amexShared
      ? `Add ${count} offers to ${selectedLabel}?`
      : `Add available ${config.issuer} offers?`;
  body.textContent = amexShared
    ? "Amex will add offers to the selected card and try verified matches on other eligible cards. You’ll see the final result when it finishes."
    : `This will add the available offers shown for ${selectedLabel ?? `this ${config.issuer} card`}. Already-submitted issuer actions cannot be undone.`;
  continueButton.textContent = count && !amexShared ? `Add ${count} offers` : "Add offers";
  offerConfirmationTrigger = button;
  modal.classList.add("visible");
  continueButton.focus();

  continueButton.onclick = () => {
    closeOfferConfirmation({ restoreFocus: false });
    button.dataset.confirmed = "true";
    button.click();
    delete button.dataset.confirmed;
  };
}

document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest(
    "#chaseOffersRunBtn, #amexOffersRunBtn, #citiOffersRunBtn",
  ) as HTMLButtonElement | null;
  if (!button) return;
  if (button.dataset.confirmed === "true") {
    if (offersFirstUiEnabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const issuer = button.id.startsWith("chase")
        ? "chase"
        : button.id.startsWith("amex")
          ? "amex"
          : "citi";
      const select = document.getElementById(`${issuer}OffersCardSelect`) as HTMLSelectElement | null;
      const state = latestOfferSnapshot.active?.issuer === issuer
        ? latestOfferSnapshot.active
        : latestOfferSnapshot.history[issuer];
      const selectedKey = select?.value ?? "";
      const selected = state?.cards.find((card) => card.key === selectedKey);
      void startTrackedEnrollment(
        issuer,
        selectedKey ? [selectedKey] : [],
        selected?.availableCount ?? null,
        {
          addMatchingOffersAcrossCards:
            issuer === "amex"
            && (document.getElementById("amexOffersSharedCheckbox") as HTMLInputElement | null)
              ?.checked === true,
        },
      ).then((result) => {
        if (result === "failed") {
          renderOfferActivityMessage(
            "Check again before adding offers",
            "The issuer session or selected card is no longer available.",
          );
        }
        void refreshOfferOperationUi();
      });
    }
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  confirmOfferEnrollment(button);
}, true);

document.getElementById("offerConfirmCancel")?.addEventListener("click", () => {
  closeOfferConfirmation({ restoreFocus: true });
});

document.getElementById("offerLimitUpgrade")?.addEventListener("click", () => {
  closeOfferLimitDialog({ restoreFocus: false });
  handleLockedProviderSelected("chase");
});
document.getElementById("offerLimitDismiss")?.addEventListener("click", () => {
  closeOfferLimitDialog({ restoreFocus: true });
});
document.getElementById("offerLimitModal")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) {
    closeOfferLimitDialog({ restoreFocus: true });
  }
});

const amexMultiEnrollDisclaimerCheckbox = document.getElementById(
  "amexMultiEnrollDisclaimerCheckbox",
) as HTMLInputElement | null;
const amexMultiEnrollDisclaimerContinue = document.getElementById(
  "amexMultiEnrollDisclaimerContinue",
) as HTMLButtonElement | null;
amexMultiEnrollDisclaimerCheckbox?.addEventListener("change", () => {
  if (amexMultiEnrollDisclaimerContinue) {
    amexMultiEnrollDisclaimerContinue.disabled =
      amexMultiEnrollDisclaimerCheckbox.checked !== true;
  }
});
amexMultiEnrollDisclaimerContinue?.addEventListener("click", () => {
  const trigger = amexMultiEnrollDisclaimerTrigger;
  if (!trigger || amexMultiEnrollDisclaimerCheckbox?.checked !== true) return;
  closeAmexMultiEnrollDisclaimer({ restoreFocus: false });
  trigger.dataset.sharedRiskAcknowledged = "true";
  confirmOfferEnrollment(trigger);
  delete trigger.dataset.sharedRiskAcknowledged;
});
document.getElementById("amexMultiEnrollDisclaimerCancel")?.addEventListener("click", () => {
  const sharedCheckbox = document.getElementById(
    "amexOffersSharedCheckbox",
  ) as HTMLInputElement | null;
  if (sharedCheckbox) sharedCheckbox.checked = false;
  closeAmexMultiEnrollDisclaimer({ restoreFocus: true });
});

document.addEventListener("click", (event) => {
  if (!offersFirstUiEnabled) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[id$='OffersRefreshBtn']",
  );
  if (!button) return;
  const issuer = button.id.startsWith("chase")
    ? "chase"
    : button.id.startsWith("amex")
      ? "amex"
      : button.id.startsWith("citi")
        ? "citi"
        : "capitalone";
  const active = latestOfferSnapshot.active;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!active || active.issuer !== issuer) {
    requestOfferCheck(issuer, () => {});
    return;
  }
  void chrome.runtime.sendMessage({
    type: "REFRESH_OFFER_CHECK",
    runId: active.runId,
  }).then((result: { ok?: boolean } | null) => {
    if (!result?.ok) {
      renderOfferActivityMessage(
        `Couldn’t refresh ${offerIssuerNames[issuer]}`,
        "Keep the issuer tab open and try again.",
      );
    }
    void refreshOfferOperationUi();
  });
}, true);

document.addEventListener("click", (event) => {
  if (!offersFirstUiEnabled) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "[id$='OffersRunAgainBtn'], [id$='OffersRetryBtn']",
  );
  if (!button) return;
  const issuer = button.id.startsWith("chase")
    ? "chase"
    : button.id.startsWith("amex")
      ? "amex"
      : button.id.startsWith("citi")
        ? "citi"
        : "capitalone";
  event.preventDefault();
  event.stopImmediatePropagation();
  requestOfferCheck(issuer, () => {});
}, true);

if (tabBar) {
  tabBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-tab]") as HTMLElement | null;
    if (!btn) return;
    const destination = btn.getAttribute("data-tab");
    if (destination === "offers" || destination === "rewards") {
      setDestination(destination);
    }
  });
  tabBar.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const destination = activeDestination === "offers" ? "rewards" : "offers";
    setDestination(destination);
    (tabBar.querySelector(`[data-tab="${destination}"]`) as HTMLButtonElement | null)?.focus();
  });

  chrome.storage.local.get(["pendingDestination", "pendingTab", "lastHomeDestination"]).then((stored) => {
    if (__REWARDS_GUIDE_QA_PREVIEW__) {
      destinationRestored = true;
      setDestination("rewards", { persist: false });
      return;
    }
    if (stored.pendingDestination === "offers" || stored.pendingTab === "tools") {
      destinationRestored = true;
      setDestination("offers", { persist: false });
      chrome.storage.local.remove(["pendingDestination", "pendingTab"]);
      chrome.action.setBadgeText({ text: "" });
      return;
    }
    if (stored.lastHomeDestination === "rewards") {
      destinationRestored = true;
      setDestination("rewards", { persist: false });
    } else if (stored.lastHomeDestination === "offers") {
      destinationRestored = true;
      setDestination("offers", { persist: false });
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
  let selectedLocale = "en-US";
  let selectedAccountKey: string | null = null;
  let amexTabId: number | null = null;
  let amexOurTabId: number | null = null;
  let amexDiscoverGen = 0;
  let amexSharedOfferCounts: Record<string, number> = {};
  let amexActiveRunId: string | null = null;

  const discoverBtn = document.getElementById("amexOffersDiscoverBtn");
  const runBtn = document.getElementById("amexOffersRunBtn") as HTMLButtonElement | null;
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
  const sharedOption = document.getElementById("amexOffersSharedOption");
  const sharedCheckbox = document.getElementById("amexOffersSharedCheckbox") as HTMLInputElement | null;
  const sharedScope = document.getElementById("amexOffersSharedScope");

  if (sharedCheckbox) sharedCheckbox.checked = false;

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
    if (offersFirstUiEnabled) {
      chrome.tabs.create({ url: "https://global.americanexpress.com/offers", active: true }, (newTab) => {
        if (!newTab?.id) {
          if (errorMsgEl) errorMsgEl.textContent = "Could not open Amex.";
          showState("Error");
          void patchOfferOperation("amex", {
            phase: "failed",
            error: "Couldn’t open Amex.",
          });
          return;
        }
        amexTabId = newTab.id;
        amexOurTabId = newTab.id;
        void patchOfferOperation("amex", {
          phase: "waiting_for_login",
          ownedTabId: newTab.id,
        });
        waitForTabLoad(newTab.id, callback);
      });
      return;
    }

    chrome.tabs.query({ url: "https://global.americanexpress.com/*", currentWindow: true }, (tabs) => {
      const tab =
        tabs.find((candidate) => candidate.active)
        ?? tabs.find((candidate) => candidate.url?.includes("/offers"))
        ?? tabs[0];

      if (tab?.id) {
        const tabId = tab.id;
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
        void patchOfferOperation("amex", {
          phase: "failed",
          error: "Couldn’t check Amex. Make sure you’re signed in.",
        });
        return;
      }

      if (resp.error === "no_cards") {
        if (retriesLeft > 0) {
          setTimeout(() => tryDiscoverOffers(tabId, gen, retriesLeft - 1), 3000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "No Amex cards found. Make sure you're signed in and try again.";
        showState("Error");
        void patchOfferOperation("amex", {
          phase: "failed",
          error: "No Amex cards were found. Finish signing in, then try again.",
        });
        return;
      }
      amexCards = resp.cards ?? [];
      amexOfferCounts = resp.offerCounts ?? {};
      const sharedOfferEntries: Array<[string, number]> = [];
      if (Array.isArray(resp.sharedOfferPreview)) {
        for (const entry of resp.sharedOfferPreview) {
          if (!entry || typeof entry !== "object") continue;
          const record = entry as Record<string, unknown>;
          if (typeof record.cardId === "string" && typeof record.sharedOfferCount === "number") {
            sharedOfferEntries.push([record.cardId, record.sharedOfferCount]);
          }
        }
      }
      amexSharedOfferCounts = Object.fromEntries(sharedOfferEntries);
      if (amexCards.length > 0 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = amexCards.map((c) => {
          const n = amexOfferCounts[c.id];
          const suffix = n > 0 ? ` (${formatAvailableToActivate(n)})` : "";
          return `<option value="${escapeHtml(c.id)}" data-locale="${escapeHtml(c.locale ?? "en-US")}">${escapeHtml(`${formatCardDisplayName(c)}${suffix}`)}</option>`;
        }).join("");
        cardSelectWrap.style.display = "";
      }
      const refreshedSelectedCard = amexCards.find((card) => card.id === selectedCardId) ?? amexCards[0];
      selectedCardId = refreshedSelectedCard?.id ?? "";
      selectedLocale = refreshedSelectedCard?.locale ?? "en-US";
      selectedAccountKey = refreshedSelectedCard?.accountKey ?? null;
      if (cardSelect) cardSelect.value = selectedCardId;
      updateOfferCountLabel();
      renderOfferCardChoices({
        issuer: "amex",
        cards: amexCards,
        counts: amexOfferCounts,
        select: cardSelect,
        selectWrap: cardSelectWrap,
        runButton: runBtn,
      });
      showState("Ready");
      const operationCards: OfferOperationCard[] = amexCards.map((card, index) => ({
        key: `card-${index}`,
        name: card.name || "Amex card",
        lastDigits: card.lastDigits,
        availableCount:
          typeof amexOfferCounts[card.id] === "number" ? amexOfferCounts[card.id] : null,
        countStatus:
          typeof amexOfferCounts[card.id] === "number" ? "complete" : "unknown",
      }));
      void patchOfferOperation("amex", {
        phase: "ready_to_add",
        cards: operationCards,
      });
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
      void patchOfferOperation("amex", { phase: "checking", ownedTabId: tabId });
      tryDiscoverOffers(tabId, gen);
    });
  }
  discoverBtn?.addEventListener("click", (e) => { e.stopPropagation(); requestOfferCheck("amex", handleAmexDiscover); });
  amexCard?.addEventListener("click", () => { if (panels.Initial?.style.display !== "none") requestOfferCheck("amex", handleAmexDiscover); });
  document.getElementById("amexOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    amexDiscoverGen++;
    showState("Initial");
    if (amexOurTabId) { chrome.tabs.remove(amexOurTabId); }
    amexTabId = null;
    amexOurTabId = null;
    const runId = activeOfferRunIds.get("amex");
    if (runId) void chrome.runtime.sendMessage({ type: "CANCEL_OFFER_OPERATION", runId });
  });
  document.getElementById("amexOffersRefreshBtn")?.addEventListener("click", () => {
    requestOfferToolAction(() => {
      if (!amexTabId) return;
      showState("Loading");
      void patchOfferOperation("amex", { phase: "checking", cards: [] });
      tryDiscoverOffers(amexTabId, ++amexDiscoverGen);
    });
  });

  function updateOfferCountLabel() {
    if (!offerCountEl) return;
    const count = amexOfferCounts[selectedCardId];
    if (count === undefined) {
      offerCountEl.textContent = "Offer count unavailable for this card. Refresh to retry.";
      return;
    }
    offerCountEl.textContent = count > 0
      ? `${formatAvailableToActivate(count)} on this card`
      : "No new offers to activate for this card";

    const sharedCount = amexSharedOfferCounts[selectedCardId] ?? 0;
    const canShowSharedEnrollment = amexCards.length > 1;
    if (sharedOption) sharedOption.style.display = canShowSharedEnrollment ? "" : "none";
    if (sharedScope) {
      sharedScope.style.display = canShowSharedEnrollment ? "" : "none";
      sharedScope.textContent = sharedCount > 0
        ? `${pluralize(sharedCount, "offer")} currently match ${pluralize(amexCards.length - 1, "other card")}. Amex may not accept every match.`
        : "We'll check for matching eligible offers before activation.";
    }
  }

  cardSelect?.addEventListener("change", () => {
    const card = findOfferToolCardBySelectValue(amexCards, cardSelect.value);
    if (card) {
      selectedCardId = card.id;
      selectedLocale = card.locale;
      selectedAccountKey = card.accountKey;
      updateOfferCountLabel();
    }
  });

  async function startAmexOfferRun(sharedPreflightId: string | null) {
    if (!amexTabId) return;
    const selectedCount = amexOfferCounts[selectedCardId];
    const requested = sharedPreflightId === null
      ? (typeof selectedCount === "number" ? selectedCount : 100)
      : Math.max(
          typeof selectedCount === "number" ? selectedCount : 0,
          Object.values(amexOfferCounts).reduce(
            (sum, count) => sum + (typeof count === "number" ? count : 0),
            0,
          ),
        );
    const reservation = await reserveLegacyEnrollment(
      requested || 100,
    );
    if (!reservation) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    if (progressDetail) progressDetail.textContent = "";
    const amexSelectedCard = amexCards.find((c) => c.id === selectedCardId);
    amexActiveRunId = reservation.runId;
    chrome.tabs.sendMessage(amexTabId, {
      type: "AMEX_OFFERS_RUN",
      runId: amexActiveRunId,
      cardId: selectedCardId,
      locale: selectedLocale,
      accountKey: selectedAccountKey,
      cardName: amexSelectedCard?.name ?? "",
      cardLastDigits: amexSelectedCard?.lastDigits ?? null,
      cards: amexCards,
      addMatchingOffersAcrossCards: sharedPreflightId !== null,
      sharedPreflightId,
      maxOffers: reservation.maxOffers,
    }, (response) => {
      if (chrome.runtime.lastError || response?.ok !== true) {
        void chrome.runtime.sendMessage({
          type: "RELEASE_OFFER_ACTIVATION",
          runId: reservation.runId,
        });
        if (errorMsgEl) errorMsgEl.textContent = response?.error ?? "Could not start Amex offers. Refresh and try again.";
        showState("Error");
      }
    });
  }

  runBtn?.addEventListener("click", () => requestOfferToolAction(() => {
    if (!amexTabId) return;
    const wantsSharedEnrollment = sharedCheckbox?.checked === true;
    if (!wantsSharedEnrollment) {
      startAmexOfferRun(null);
      return;
    }
    const preflightCardId = selectedCardId;
    chrome.tabs.sendMessage(amexTabId, {
      type: "AMEX_OFFERS_SHARED_PREFLIGHT",
      cardId: preflightCardId,
      locale: selectedLocale,
      cards: amexCards,
    }, (response) => {
      if (chrome.runtime.lastError || !response?.ok || !response.preflightId) {
        if (errorMsgEl) errorMsgEl.textContent = "Could not confirm matching Amex offers. Refresh and try again.";
        showState("Error");
        return;
      }
      const matchingOfferCount = typeof response.matchingOfferCount === "number"
        ? response.matchingOfferCount
        : 0;
      if (matchingOfferCount === 0) {
        if (sharedCheckbox) sharedCheckbox.checked = false;
        startAmexOfferRun(null);
        return;
      }
      if (selectedCardId !== preflightCardId) {
        if (errorMsgEl) errorMsgEl.textContent = "Your card selection changed. Please confirm matching offers again.";
        showState("Error");
        return;
      }
      startAmexOfferRun(response.preflightId);
    });
  }));

  stopBtn?.addEventListener("click", () => {
    if (!amexTabId) return;
    chrome.tabs.sendMessage(amexTabId, { type: "AMEX_OFFERS_STOP" });
    if (progressDetail) progressDetail.textContent = "Stopping after the current offer...";
    if (stopBtn) stopBtn.setAttribute("disabled", "true");
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
    if (amexActiveRunId && msg.runId !== amexActiveRunId) return;
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
        if (progressDetail) progressDetail.textContent = `${added} activated so far - checking for new offers...`;
      } else if (msg.status === "cooling_down") {
        if (progressBar) progressBar.style.width = `${pct}%`;
        const waitSeconds = typeof msg.waitSeconds === "number" ? msg.waitSeconds : 45;
        const suffix = typeof msg.error === "string" ? ` (${msg.error})` : "";
        if (progressDetail) progressDetail.textContent = `Amex is slowing requests; waiting ${waitSeconds}s before retrying${suffix}`;
      } else {
        if (progressBar) progressBar.style.width = `${pct}%`;
        const suffix = failed > 0 && typeof msg.error === "string" ? ` - last error: ${msg.error}` : "";
        if (progressDetail) progressDetail.textContent = `${added} of ${total} activated${suffix}`;
      }
    }
    if (msg.type === "AMEX_OFFERS_SYNCED") {
      const cardLabel = formatCardDisplayName(amexCards.find((c) => c.id === selectedCardId));
      const parts: string[] = [];
      if (msg.added > 0) {
        parts.push(msg.multiCard
          ? `${pluralize(msg.added, "offer")} activated across your Amex cards`
          : `${pluralize(msg.added, "offer")} activated for ${cardLabel}`);
      }
      if (msg.added === 0 && msg.failed === 0) parts.push(`No new offers to activate for ${cardLabel}`);
      if (msg.failed > 0) parts.push(`${pluralize(msg.failed, "enrollment attempt")} failed`);
      if (msg.unverified > 0) parts.push(`${pluralize(msg.unverified, "offer")} could not be verified`);
      if (msg.cancelled) parts.push("Stopped after the current offer");
      if (msg.sessionExpired) parts.push("Amex session expired — log in to Amex, then run again");
      else if (typeof msg.lastError === "string" && msg.lastError) parts.push(`Last Amex error: ${msg.lastError}`);
      if (typeof msg.syncError === "string" && msg.syncError) parts.push("Verified offers could not be saved to nextcard — run again after checking your connection");
      if (msg.rounds > 1) parts.push(`${msg.rounds} rounds`);
      if (summaryEl) summaryEl.textContent = parts.join(" · ");
      stopBtn?.removeAttribute("disabled");
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
    if (offersFirstUiEnabled) {
      chrome.tabs.create({ url: "https://secure.chase.com/web/auth/dashboard", active: true }, (newTab) => {
        if (!newTab?.id) {
          if (errorMsgEl) errorMsgEl.textContent = "Could not open Chase.";
          showState("Error");
          void patchOfferOperation("chase", {
            phase: "failed",
            error: "Couldn’t open Chase.",
          });
          return;
        }
        chaseTabId = newTab.id;
        chaseOurTabId = newTab.id;
        void patchOfferOperation("chase", {
          phase: "waiting_for_login",
          ownedTabId: newTab.id,
        });
        waitForChaseTabLoad(newTab.id, callback);
      });
      return;
    }

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
        void patchOfferOperation("chase", {
          phase: "failed",
          error: "Couldn’t check Chase. Make sure you’re signed in.",
        });
        return;
      }
      if (resp.error === "no_cards") {
        if (retriesLeft > 0) {
          setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000);
          return;
        }
        if (errorMsgEl) errorMsgEl.textContent = "No Chase cards found. Sign in and try again.";
        showState("Error");
        void patchOfferOperation("chase", {
          phase: "failed",
          error: "No Chase cards were found. Finish signing in, then try again.",
        });
        return;
      }
      chaseCards = resp.cards ?? [];
      chaseOfferCounts = resp.offerCounts ?? {};
      if (chaseCards.length > 0 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = chaseCards.map((c) => {
          const n = chaseOfferCounts[c.id] ?? 0;
          const suffix = n > 0 ? ` (${formatAvailableToActivate(n)})` : "";
          return `<option value="${escapeHtml(c.id)}">${escapeHtml(`${formatCardDisplayName(c)}${suffix}`)}</option>`;
        }).join("");
        cardSelectWrap.style.display = chaseCards.length > 1 ? "" : "none";
      }
      selectedCardId = chaseCards[0]?.id ?? "";
      updateChaseOfferCountLabel();
      renderOfferCardChoices({
        issuer: "chase",
        cards: chaseCards,
        counts: chaseOfferCounts,
        select: cardSelect,
        selectWrap: cardSelectWrap,
        runButton: document.getElementById("chaseOffersRunBtn") as HTMLButtonElement | null,
      });
      showState("Ready");
      const operationCards: OfferOperationCard[] = chaseCards.map((card, index) => ({
        key: `card-${index}`,
        name: card.name || "Chase card",
        lastDigits: card.lastDigits,
        availableCount:
          typeof chaseOfferCounts[card.id] === "number" ? chaseOfferCounts[card.id] : null,
        countStatus:
          typeof chaseOfferCounts[card.id] === "number" ? "complete" : "unknown",
      }));
      void patchOfferOperation("chase", {
        phase: "ready_to_add",
        cards: operationCards,
      });
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
      void patchOfferOperation("chase", { phase: "checking", ownedTabId: tabId });
      tryDiscover(tabId, gen);
    });
  }
  document.getElementById("chaseOffersDiscoverBtn")?.addEventListener("click", (e) => { e.stopPropagation(); requestOfferCheck("chase", handleChaseDiscover); });
  chaseCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") requestOfferCheck("chase", handleChaseDiscover); });
  document.getElementById("chaseOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    chaseDiscoverGen++;
    showState("Initial");
    if (chaseOurTabId) { chrome.tabs.remove(chaseOurTabId); }
    chaseTabId = null;
    chaseOurTabId = null;
    const runId = activeOfferRunIds.get("chase");
    if (runId) void chrome.runtime.sendMessage({ type: "CANCEL_OFFER_OPERATION", runId });
  });
  document.getElementById("chaseOffersRefreshBtn")?.addEventListener("click", () => {
    requestOfferToolAction(() => {
      if (!chaseTabId) return;
      showState("Loading");
      void patchOfferOperation("chase", { phase: "checking", cards: [] });
      tryDiscover(chaseTabId, ++chaseDiscoverGen);
    });
  });

  function updateChaseOfferCountLabel() {
    if (!offerCountEl) return;
    const count = chaseOfferCounts[selectedCardId] ?? 0;
    offerCountEl.textContent = count > 0
      ? `${formatAvailableToActivate(count)} on this card`
      : "No new offers to activate for this card";
  }

  cardSelect?.addEventListener("change", () => {
    const card = findOfferToolCardBySelectValue(chaseCards, cardSelect.value);
    if (card) {
      selectedCardId = card.id;
      updateChaseOfferCountLabel();
    }
  });

  document.getElementById("chaseOffersRunBtn")?.addEventListener("click", () => requestOfferToolAction(async () => {
    if (!chaseTabId) return;
    const requested = typeof chaseOfferCounts[selectedCardId] === "number"
      ? chaseOfferCounts[selectedCardId]
      : 100;
    const reservation = await reserveLegacyEnrollment(requested);
    if (!reservation) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    if (progressDetail) progressDetail.textContent = "";
    const allCardIds = chaseCards.map((c) => c.id);
    const chaseSelectedCard = chaseCards.find((c) => c.id === selectedCardId);
    chrome.tabs.sendMessage(chaseTabId, {
      type: "CHASE_OFFERS_RUN",
      runId: reservation.runId,
      cardId: selectedCardId,
      allCardIds,
      cardName: chaseSelectedCard?.name ?? "",
      cardLastDigits: chaseSelectedCard?.lastDigits ?? null,
      maxOffers: reservation.maxOffers,
    }, (response) => {
      if (chrome.runtime.lastError || response?.ok !== true) {
        void chrome.runtime.sendMessage({
          type: "RELEASE_OFFER_ACTIVATION",
          runId: reservation.runId,
        });
        showState("Error");
      }
    });
  }));

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
      if (progressDetail) progressDetail.textContent = total > 0 ? `${added} of ${total} activated` : `${added} activated`;
    }
    if (msg.type === "CHASE_OFFERS_COMPLETE") {
      const cardLabel = formatCardDisplayName(chaseCards.find((c) => c.id === selectedCardId));
      const parts: string[] = [];
      if (msg.added > 0) parts.push(`${pluralize(msg.added, "offer")} activated for ${cardLabel}`);
      if (msg.added === 0) parts.push(`No new offers to activate for ${cardLabel}`);
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
    if (offersFirstUiEnabled) {
      chrome.tabs.create({ url: "https://online.citi.com/US/ag/dashboard", active: true }, (newTab) => {
        if (!newTab?.id) {
          if (errorMsgEl) errorMsgEl.textContent = "Could not open Citi.";
          showState("Error");
          void patchOfferOperation("citi", {
            phase: "failed",
            error: "Couldn’t open Citi.",
          });
          return;
        }
        const tabId = newTab.id;
        citiTabId = tabId;
        citiOurTabId = tabId;
        void patchOfferOperation("citi", {
          phase: "waiting_for_login",
          ownedTabId: tabId,
        });
        const dashboardListener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId !== tabId || info.status !== "complete") return;
          chrome.tabs.onUpdated.removeListener(dashboardListener);
          chrome.tabs.update(tabId, {
            url: "https://online.citi.com/US/ag/products-offers/merchantoffers",
          });
          const offersListener = (offersTabId: number, offersInfo: chrome.tabs.TabChangeInfo) => {
            if (offersTabId !== tabId || offersInfo.status !== "complete") return;
            chrome.tabs.onUpdated.removeListener(offersListener);
            setTimeout(() => callback(tabId), 3000);
          };
          chrome.tabs.onUpdated.addListener(offersListener);
        };
        chrome.tabs.onUpdated.addListener(dashboardListener);
      });
      return;
    }

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
        void patchOfferOperation("citi", {
          phase: "failed",
          error: "Couldn’t check Citi. Make sure you’re signed in.",
        });
        return;
      }
      if (resp.error === "no_cards") {
        if (retriesLeft > 0) { setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000); return; }
        if (errorMsgEl) errorMsgEl.textContent = "No Citi cards found. Sign in and try again.";
        showState("Error");
        void patchOfferOperation("citi", {
          phase: "failed",
          error: "No Citi cards were found. Finish signing in, then try again.",
        });
        return;
      }
      citiCards = resp.cards ?? [];
      citiOfferCounts = resp.offerCounts ?? {};
      if (citiCards.length > 0 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = citiCards.map((c) => {
          const n = citiOfferCounts[c.id] ?? 0;
          const suffix = n > 0 ? ` (${formatAvailableToActivate(n)})` : "";
          return `<option value="${escapeHtml(c.id)}">${escapeHtml(`${formatCardDisplayName(c)}${suffix}`)}</option>`;
        }).join("");
        cardSelectWrap.style.display = citiCards.length > 1 ? "" : "none";
      }
      selectedAccountId = citiCards[0]?.id ?? "";
      updateCitiOfferCountLabel();
      renderOfferCardChoices({
        issuer: "citi",
        cards: citiCards,
        counts: citiOfferCounts,
        select: cardSelect,
        selectWrap: cardSelectWrap,
        runButton: document.getElementById("citiOffersRunBtn") as HTMLButtonElement | null,
      });
      showState("Ready");
      const operationCards: OfferOperationCard[] = citiCards.map((card, index) => ({
        key: `card-${index}`,
        name: card.name || "Citi card",
        lastDigits: card.lastDigits,
        availableCount:
          typeof citiOfferCounts[card.id] === "number" ? citiOfferCounts[card.id] : null,
        countStatus:
          typeof citiOfferCounts[card.id] === "number" ? "complete" : "unknown",
      }));
      void patchOfferOperation("citi", {
        phase: "ready_to_add",
        cards: operationCards,
      });
    });
  }

  const citiCard = document.getElementById("citiOffersCard");
  function handleCitiDiscover() {
    const gen = ++citiDiscoverGen;
    showState("Loading");
    citiTabId = null;
    findOrOpenCitiTab((tabId) => {
      if (gen !== citiDiscoverGen) return;
      citiTabId = tabId;
      void patchOfferOperation("citi", { phase: "checking", ownedTabId: tabId });
      tryDiscover(tabId, gen);
    });
  }
  document.getElementById("citiOffersDiscoverBtn")?.addEventListener("click", (e) => { e.stopPropagation(); requestOfferCheck("citi", handleCitiDiscover); });
  citiCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") requestOfferCheck("citi", handleCitiDiscover); });
  document.getElementById("citiOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    citiDiscoverGen++;
    showState("Initial");
    if (citiOurTabId) { chrome.tabs.remove(citiOurTabId); }
    citiTabId = null;
    citiOurTabId = null;
    const runId = activeOfferRunIds.get("citi");
    if (runId) void chrome.runtime.sendMessage({ type: "CANCEL_OFFER_OPERATION", runId });
  });
  document.getElementById("citiOffersRefreshBtn")?.addEventListener("click", () => {
    requestOfferToolAction(() => {
      if (!citiTabId) return;
      showState("Loading");
      void patchOfferOperation("citi", { phase: "checking", cards: [] });
      tryDiscover(citiTabId, ++citiDiscoverGen);
    });
  });

  function updateCitiOfferCountLabel() {
    if (!offerCountEl) return;
    const count = citiOfferCounts[selectedAccountId] ?? 0;
    offerCountEl.textContent = count > 0
      ? `${formatAvailableToActivate(count)} on this card`
      : "No new offers to activate for this card";
  }

  cardSelect?.addEventListener("change", () => {
    const card = findOfferToolCardBySelectValue(citiCards, cardSelect.value);
    if (card) {
      selectedAccountId = card.id;
      updateCitiOfferCountLabel();
    }
  });

  document.getElementById("citiOffersRunBtn")?.addEventListener("click", () => requestOfferToolAction(async () => {
    if (!citiTabId) return;
    const requested = typeof citiOfferCounts[selectedAccountId] === "number"
      ? citiOfferCounts[selectedAccountId]
      : 100;
    const reservation = await reserveLegacyEnrollment(requested);
    if (!reservation) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    const citiSelectedCard = citiCards.find((c) => c.id === selectedAccountId);
    chrome.tabs.sendMessage(citiTabId, {
      type: "CITI_OFFERS_RUN",
      runId: reservation.runId,
      accountId: selectedAccountId,
      cardName: citiSelectedCard?.name ?? "",
      cardLastDigits: citiSelectedCard?.lastDigits ?? null,
      maxOffers: reservation.maxOffers,
    }, (response) => {
      if (chrome.runtime.lastError || response?.ok !== true) {
        void chrome.runtime.sendMessage({
          type: "RELEASE_OFFER_ACTIVATION",
          runId: reservation.runId,
        });
        showState("Error");
      }
    });
  }));

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
      if (progressDetail) progressDetail.textContent = total > 0 ? `${added} of ${total} activated` : `${added} activated`;
    }
    if (msg.type === "CITI_OFFERS_COMPLETE") {
      const cardLabel = formatCardDisplayName(citiCards.find((c) => c.id === selectedAccountId));
      const parts: string[] = [];
      if (msg.added > 0) parts.push(`${pluralize(msg.added, "offer")} activated for ${cardLabel}`);
      if (msg.added === 0) parts.push(`No new offers to activate for ${cardLabel}`);
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
    if (offersFirstUiEnabled) {
      chrome.tabs.create({ url: "https://myaccounts.capitalone.com/accountSummary", active: true }, (newTab) => {
        if (!newTab?.id) {
          if (errorMsgEl) errorMsgEl.textContent = "Could not open Capital One.";
          showState("Error");
          void patchOfferOperation("capitalone", {
            phase: "failed",
            error: "Couldn’t open Capital One.",
          });
          return;
        }
        capitalOneTabId = newTab.id;
        capitalOneOurTabId = newTab.id;
        void patchOfferOperation("capitalone", {
          phase: "waiting_for_login",
          ownedTabId: newTab.id,
        });
        waitForCapitalOneTabLoad(newTab.id, callback);
      });
      return;
    }

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
    const accountCount = capitalOneCards.length;
    offerCountEl.textContent = total > 0
      ? `${pluralize(total, "offer")} found across ${pluralize(accountCount, "account")}`
      : "No shopping offers found";
  }

  function updateDoneSummary() {
    if (!summaryEl) return;
    const total = totalOfferCount();
    const accountCount = capitalOneCards.length;
    summaryEl.textContent = total > 0
      ? `${pluralize(total, "offer")} saved across ${pluralize(accountCount, "account")}`
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
        void patchOfferOperation("capitalone", {
          phase: "failed",
          error: "Couldn’t check Capital One. Make sure you’re signed in.",
        });
        return;
      }
      if (resp.redirectUrl) {
        chrome.tabs.update(tabId, { active: true, url: resp.redirectUrl }, () => {
          waitForCapitalOneTabLoad(tabId, (loadedTabId) => tryDiscover(loadedTabId, gen, retriesLeft));
        });
        return;
      }
      if (resp.error === "no_cards" || resp.error === "no_accounts") {
        if (retriesLeft > 0) { setTimeout(() => tryDiscover(tabId, gen, retriesLeft - 1), 3000); return; }
        if (errorMsgEl) errorMsgEl.textContent = "No eligible Capital One accounts found. Sign in and try again.";
        showState("Error");
        void patchOfferOperation("capitalone", {
          phase: "failed",
          error: "No eligible Capital One accounts were found.",
        });
        return;
      }
      if (resp.error) {
        if (errorMsgEl) errorMsgEl.textContent = "Could not save Capital One offers. Try again in a minute.";
        showState("Error");
        void patchOfferOperation("capitalone", {
          phase: "failed",
          error: "Couldn’t save Capital One offers. Try again.",
          saveStatus: "failed",
        });
        return;
      }

      capitalOneCards = resp.cards ?? [];
      capitalOneOfferCounts = resp.offerCounts ?? {};
      if (cardSelectWrap) cardSelectWrap.style.display = "none";
      if (capitalOneCards.length > 1 && cardSelect && cardSelectWrap) {
        cardSelect.innerHTML = capitalOneCards.map((card) => {
          const count = capitalOneOfferCounts[card.id] ?? 0;
          const suffix = count > 0 ? ` (${pluralize(count, "offer")} found)` : "";
          const label = `${formatCardDisplayName(card)}${suffix}`;
          return `<option value="${escapeHtml(card.id)}">${escapeHtml(label)}</option>`;
        }).join("");
        cardSelectWrap.style.display = "";
      }
      updateOfferCountLabel();
      if (loadingProgressBar) loadingProgressBar.style.width = "100%";
      if (loadingProgressDetail) loadingProgressDetail.textContent = "Offers saved";
      updateDoneSummary();
      showState("Done");
      const operationCards: OfferOperationCard[] = capitalOneCards.map((card, index) => ({
        key: `card-${index}`,
        name: card.name || "Capital One account",
        lastDigits: card.lastDigits,
        availableCount:
          typeof capitalOneOfferCounts[card.id] === "number"
            ? capitalOneOfferCounts[card.id]
            : null,
        countStatus:
          typeof capitalOneOfferCounts[card.id] === "number" ? "complete" : "unknown",
      }));
      void patchOfferOperation("capitalone", {
        phase: "completed",
        cards: operationCards,
        total: totalOfferCount(),
        saveStatus: "saved",
      });
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
      void patchOfferOperation("capitalone", { phase: "checking", ownedTabId: tabId });
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

  document.getElementById("capitaloneOffersDiscoverBtn")?.addEventListener("click", (e) => { e.stopPropagation(); requestOfferCheck("capitalone", handleDiscover); });
  capitalOneCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") requestOfferCheck("capitalone", handleDiscover); });
  document.getElementById("capitaloneOffersLoadingCancel")?.addEventListener("click", (e) => {
    e.stopPropagation();
    capitalOneDiscoverGen++;
    showState("Initial");
    if (capitalOneOurTabId) { chrome.tabs.remove(capitalOneOurTabId); }
    capitalOneTabId = null;
    capitalOneOurTabId = null;
    const runId = activeOfferRunIds.get("capitalone");
    if (runId) void chrome.runtime.sendMessage({ type: "CANCEL_OFFER_OPERATION", runId });
  });
  document.getElementById("capitaloneOffersRefreshBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    requestOfferToolAction(handleRefresh);
  });

  document.getElementById("capitaloneOffersRunBtn")?.addEventListener("click", () => requestOfferToolAction(() => {
    if (!capitalOneTabId) return;
    showState("Running");
    if (progressBar) progressBar.style.width = "0%";
    if (progressDetail) progressDetail.textContent = "Syncing all accounts...";
    chrome.tabs.sendMessage(capitalOneTabId, { type: "CAPITALONE_OFFERS_RUN" });
  }));

  document.getElementById("capitaloneOffersStopBtn")?.addEventListener("click", () => {
    if (!capitalOneTabId) return;
    chrome.tabs.sendMessage(capitalOneTabId, { type: "CAPITALONE_OFFERS_STOP" });
    showState("Done");
    if (summaryEl) summaryEl.textContent = "Cancelled";
  });

  document.getElementById("capitaloneOffersRunAgainBtn")?.addEventListener("click", () => {
    requestOfferToolAction(handleRefresh);
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
            ? `Account ${Number(cardIndex) + 1} of ${cardTotal} · page ${page} · ${offersFound} offers`
            : "Opening full offers feed...";
        }
      }
      const synced = msg.synced ?? 0;
      const total = msg.total ?? totalOfferCount();
      const pct = total > 0 ? Math.min(100, Math.round((synced / total) * 100)) : 0;
      if (progressBar) progressBar.style.width = `${pct}%`;
      if (progressDetail) progressDetail.textContent = total > 0 ? `${synced} of ${total} synced` : `${synced} synced`;
    }
    if (msg.type === "CAPITALONE_OFFERS_COMPLETE") {
      const synced = msg.synced ?? 0;
      if (summaryEl) summaryEl.textContent = synced > 0
        ? `${pluralize(synced, "offer")} synced`
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
  document.getElementById("discoverBonusBtn")?.addEventListener("click", (e) => { e.stopPropagation(); requestToolConsent(handleDiscoverBonus); });
  discoverCard?.addEventListener("click", () => { if (states.Initial?.style.display !== "none") requestToolConsent(handleDiscoverBonus); });

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

  document.getElementById("chaseBonusRegisterBtn")?.addEventListener("click", () => requestToolConsent(() => {
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
  }));

  document.getElementById("chaseBonusAgainBtn")?.addEventListener("click", () => showState("Initial"));
  document.getElementById("chaseBonusRetryBtn")?.addEventListener("click", () => showState("Initial"));
}

initChaseBonusRegistration();

let currentView: ViewName = "loading";
let disclosureAccepted = false;
let consentGiven = false;
let firstSyncCompleted = false;
let flagsLoaded = false;
let tourSyncProvider: ProviderId | null = null;
let tourSyncBaselineLastSyncedAt: string | null = null;
let tourSyncObservedInProgress = false;
let latestProviderStates: ProviderStateMap | null = null;
let extensionProfile: ExtensionProfile | null = null;
let offersSetupCompleted = false;
let offersSetupCompletedStorageKey: string | null = null;
let guidedOfferIssuer: OfferIssuer | null = null;
let offersCoachmarkSeen = false;
let offersIntroVersion = 0;
let replayingOnboarding = false;
let rewardsGuideQaPreviewActive = __REWARDS_GUIDE_QA_PREVIEW__;
let latestOfferSnapshot: OfferOperationSnapshot = { active: null, history: {} };
let appliedOffersFirstMode: boolean | null = null;
let currentAuth: NextCardAuth | null = null;
let awaitingNextcardAuth = false;
let nextcardAuthWaitTimeout: number | null = null;

const iconUrl = chrome.runtime.getURL("src/icons/icon128.png");
authElements.authLogo.src = iconUrl;
authElements.loadingLogo.src = iconUrl;
authElements.disclosureLogo.src = iconUrl;

function applyOffersFirstMode(profile: ExtensionProfile | null) {
  const enabled =
    __OFFERS_FIRST_UI_DEV_OVERRIDE__
    || profile?.offersFirstUiEnabled === true;
  offersFirstUiEnabled = enabled;
  if (appliedOffersFirstMode === enabled) return;
  appliedOffersFirstMode = enabled;

  document.body.classList.toggle("legacy-ui", !enabled);
  const offersTab = tabBar?.querySelector("[data-tab='offers']");
  const rewardsTab = tabBar?.querySelector("[data-tab='rewards']");
  if (offersTab) offersTab.textContent = enabled ? "Offers" : "tools";
  if (rewardsTab) rewardsTab.textContent = enabled ? "Rewards" : "sync";
  if (tabBar && offersTab && rewardsTab) {
    tabBar.append(
      enabled ? offersTab : rewardsTab,
      enabled ? rewardsTab : offersTab,
    );
  }
  const offersMore = document.getElementById("offersMore") as HTMLDetailsElement | null;
  if (offersMore) offersMore.open = !enabled;

  setDestination(
    destinationRestored ? activeDestination : enabled ? "offers" : "rewards",
    { persist: false },
  );
}

function renderOfferActivityMessage(title: string, detail: string) {
  const container = document.getElementById("offerActivity");
  const titleElement = document.getElementById("offerActivityTitle");
  const detailElement = document.getElementById("offerActivityDetail");
  if (!container || !titleElement || !detailElement) return;
  container.hidden = false;
  titleElement.textContent = title;
  detailElement.textContent = detail;
}

function formatOfferCheckDate(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderOfferActivationUsage() {
  const card = document.getElementById("offerUsageCard");
  const value = document.getElementById("offerUsageValue");
  const detail = document.getElementById("offerUsageDetail");
  const upgrade = document.getElementById(
    "offerUsageUpgrade",
  ) as HTMLButtonElement | null;
  const track = document.getElementById("offerUsageTrack");
  const fill = document.getElementById("offerUsageFill") as HTMLElement | null;
  if (
    !card
    || !value
    || !detail
    || !upgrade
    || !track
    || !fill
    || !offerActivationUsage
  ) return;

  const { used, limit, remaining, accountLevel } = offerActivationUsage;
  const isPro = accountLevel === "pro" || limit == null;
  card.classList.toggle("unlimited", isPro);
  value.textContent = `${isPro ? used : Math.min(used, limit)} / ${isPro ? "∞" : limit}`;
  detail.textContent = isPro
    ? "Unlimited with Pro"
    : `${remaining ?? 0} remaining this month`;
  upgrade.hidden = isPro;
  track.setAttribute(
    "aria-valuetext",
    isPro
      ? `${used} activations this month, unlimited`
      : `${used} of ${limit} activations used this month`,
  );
  if (isPro) {
    track.removeAttribute("aria-valuemin");
    track.removeAttribute("aria-valuemax");
    track.removeAttribute("aria-valuenow");
    fill.style.width = "100%";
  } else {
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(limit));
    track.setAttribute("aria-valuenow", String(Math.min(used, limit)));
    fill.style.width = `${Math.min(100, (used / limit) * 100)}%`;
  }
}

document.getElementById("offerUsageUpgrade")?.addEventListener("click", () => {
  handleLockedProviderSelected("chase");
});

function updateIssuerCardStatus(snapshot: OfferOperationSnapshot) {
  const cardIds: Record<OfferIssuer, string> = {
    chase: "chaseOffersCard",
    amex: "amexOffersCard",
    citi: "citiOffersCard",
    capitalone: "capitaloneOffersCard",
  };
  for (const issuer of Object.keys(cardIds) as OfferIssuer[]) {
    const card = document.getElementById(cardIds[issuer]);
    const description = card?.querySelector(".provider-desc");
    if (!description) continue;
    const state = snapshot.active?.issuer === issuer
      ? snapshot.active
      : snapshot.history[issuer];
    if (!state) {
      description.textContent = issuer === "capitalone"
        ? "Find and save shopping offers"
        : "Not checked · Check for offers";
      continue;
    }
    const checkedDate = formatOfferCheckDate(state.checkedAt);
    const suffix =
      state.phase === "ready_to_add" && !isOfferResultFresh(state) && checkedDate
        ? ` · last checked ${checkedDate}`
        : "";
    description.textContent = `${getOfferOperationStatusText(state)}${suffix}`;
  }
}

function renderBackgroundOwnedIssuerState(snapshot: OfferOperationSnapshot) {
  if (!offersFirstUiEnabled) return;
  for (const issuer of ["chase", "amex", "citi"] as const) {
    const state = snapshot.active?.issuer === issuer
      ? snapshot.active
      : snapshot.history[issuer];
    if (!state) continue;
    const panelNames = ["Initial", "Loading", "Ready", "Running", "Done", "Error"] as const;
    const targetPanel =
      state.phase === "ready_to_add"
        ? "Ready"
        : state.phase === "adding"
          ? "Running"
          : state.phase === "completed" || state.phase === "cancelled"
            ? "Done"
            : state.phase === "failed" || state.phase === "interrupted"
              ? "Error"
              : "Loading";
    for (const panelName of panelNames) {
      const panel = document.getElementById(`${issuer}Offers${panelName}`);
      if (panel) panel.style.display = panelName === targetPanel ? "" : "none";
    }

    const select = document.getElementById(`${issuer}OffersCardSelect`) as HTMLSelectElement | null;
    const selectWrap = document.getElementById(`${issuer}OffersCardSelectWrap`);
    if (select && state.cards.length > 0) {
      const previousValue = select.value;
      select.innerHTML = state.cards.map((card) => {
        const count = card.availableCount;
        const suffix =
          count == null
            ? " (count unavailable)"
            : count > 0
              ? ` (${formatAvailableToActivate(count)})`
              : " (no new offers)";
        return `<option value="${escapeHtml(card.key)}">${escapeHtml(`${formatCardDisplayName(card)}${suffix}`)}</option>`;
      }).join("");
      select.value = state.cards.some((card) => card.key === previousValue)
        ? previousValue
        : state.cards[0].key;
      const runButton = document.getElementById(`${issuer}OffersRunBtn`) as HTMLButtonElement | null;
      renderOfferCardChoices({
        issuer,
        cards: state.cards.map((card) => ({
          id: card.key,
          name: card.name,
          lastDigits: card.lastDigits,
        })),
        counts: Object.fromEntries(
          state.cards.map((card) => [card.key, card.availableCount ?? 0]),
        ),
        select,
        selectWrap,
        runButton,
      });
    }

    const updateSelection = () => {
      const selected = state.cards.find((card) => card.key === select?.value) ?? state.cards[0];
      const countElement = document.getElementById(`${issuer}OffersOfferCount`);
      const runButton = document.getElementById(`${issuer}OffersRunBtn`) as HTMLButtonElement | null;
      const readyPanel = document.getElementById(`${issuer}OffersReady`);
      const refreshButton = document.getElementById(
        `${issuer}OffersRefreshBtn`,
      ) as HTMLButtonElement | null;
      const fresh = isOfferResultFresh(state);
      const availableCount = selected?.availableCount ?? null;
      const isFree = offerActivationUsage?.accountLevel !== "pro";
      const remaining = isFree ? offerActivationUsage?.remaining ?? 0 : null;
      const enrollmentCount =
        availableCount == null
          ? null
          : remaining == null
            ? availableCount
            : Math.min(availableCount, remaining);
      if (refreshButton) refreshButton.textContent = fresh ? "Refresh" : "Check again";
      if (issuer === "amex") {
        const sharedOption = document.getElementById("amexOffersSharedOption");
        const sharedCheckbox = document.getElementById(
          "amexOffersSharedCheckbox",
        ) as HTMLInputElement | null;
        const sharedScope = document.getElementById("amexOffersSharedScope");
        const sharedCount = selected?.sharedOfferCount ?? 0;
        const canTryMultipleCards = state.cards.length > 1 && sharedCount > 0;
        if (sharedOption) sharedOption.style.display = canTryMultipleCards ? "" : "none";
        if (sharedScope) {
          sharedScope.style.display = canTryMultipleCards ? "" : "none";
          sharedScope.textContent = canTryMultipleCards
            ? `${pluralize(sharedCount, "offer")} currently match at least one other eligible card. This advanced option is off by default.`
            : "";
        }
        if (!canTryMultipleCards && sharedCheckbox) sharedCheckbox.checked = false;
      }
      if (countElement) {
        countElement.textContent =
          availableCount == null
            ? "Offer count unavailable for this card. Check again."
            : availableCount > 0
              ? `${formatAvailableToActivate(availableCount)} on this card`
              : "No new offers to activate for this card";
      }
      let quotaNotice = document.getElementById(`${issuer}OffersQuotaNotice`);
      const shouldShowQuota =
        isFree
        && availableCount != null
        && remaining != null
        && availableCount > remaining;
      if (shouldShowQuota && readyPanel) {
        if (!quotaNotice) {
          quotaNotice = document.createElement("div");
          quotaNotice.id = `${issuer}OffersQuotaNotice`;
          quotaNotice.className = "offer-quota-notice";
          runButton?.insertAdjacentElement("beforebegin", quotaNotice);
        }
        const quotaMessage = remaining === 0
          ? "You’ve used all 100 Free activations for this month."
          : `Your Free plan has ${remaining} activation${remaining === 1 ? "" : "s"} left this month. This run will add up to ${remaining}.`;
        quotaNotice.innerHTML = `
          <span>${quotaMessage}</span>
          <button type="button">Upgrade to Pro for unlimited activations</button>
        `;
        quotaNotice.querySelector("button")?.addEventListener(
          "click",
          handleLockedProviderSelected.bind(null, "chase"),
        );
      } else {
        quotaNotice?.remove();
      }
      if (runButton) {
        runButton.textContent =
          enrollmentCount != null && enrollmentCount > 0
            ? `Add ${enrollmentCount} offers`
            : availableCount != null && availableCount > 0 && remaining === 0
              ? "Monthly limit reached"
            : "Add offers";
        if (enrollmentCount != null) {
          runButton.dataset.enrollmentCount = String(enrollmentCount);
        } else {
          delete runButton.dataset.enrollmentCount;
        }
        runButton.disabled =
          !fresh
          || availableCount == null
          || availableCount === 0
          || enrollmentCount === 0;
      }
    };
    if (select) select.onchange = updateSelection;
    updateSelection();

    const errorElement = document.getElementById(`${issuer}OffersErrorMsg`);
    if (errorElement && state.error) errorElement.textContent = state.error;
    const progress = document.getElementById(`${issuer}OffersProgressDetail`);
    if (progress && state.phase === "adding") {
      progress.textContent = state.total == null
        ? `${state.added} added`
        : `${state.added} of ${state.total} added`;
    }
    const summary = document.getElementById(`${issuer}OffersSummary`);
    if (summary && (state.phase === "completed" || state.phase === "cancelled")) {
      const outcome = state.phase === "cancelled"
        ? `Stopped · ${state.added} added, ${state.remaining ?? 0} not attempted`
        : state.failed > 0
          ? `${state.added} added · ${state.failed} couldn’t be added`
          : `${state.added} offers added`;
      const saveOutcome =
        state.saveStatus === "queued_for_retry"
          ? " · queued to save to nextcard"
          : state.saveStatus === "failed"
            ? ` · ${state.saveError ?? "couldn’t save to nextcard"}`
            : state.saveStatus === "saved"
              ? " · saved to nextcard"
              : "";
      summary.textContent = `${outcome}${saveOutcome}`;
    }
  }
}

function resetOfferAccountUi() {
  latestOfferSnapshot = { active: null, history: {} };
  activeOfferRunIds.clear();
  offerActivationUsage = null;
  offerActivationUsageFetchedAt = 0;
  offerActivationUsageRequest = null;
  guidedOfferIssuer = null;
  renderOfferActivationUsage();
  const activity = document.getElementById("offerActivity");
  if (activity) activity.hidden = true;
  for (const issuer of ["chase", "amex", "citi", "capitalone"] as const) {
    for (const panelName of ["Initial", "Loading", "Ready", "Running", "Done", "Error"]) {
      const panel = document.getElementById(`${issuer}Offers${panelName}`);
      if (panel) panel.style.display = panelName === "Initial" ? "" : "none";
    }
    const select = document.getElementById(`${issuer}OffersCardSelect`) as HTMLSelectElement | null;
    if (select) select.innerHTML = "";
    document.getElementById(`${issuer}OfferCardChoices`)?.remove();
    const card = document.getElementById(`${issuer}OffersCard`);
    const description = card?.querySelector(".provider-desc");
    if (description) {
      description.textContent = issuer === "capitalone"
        ? "Find and save shopping offers"
        : "Not checked · Check for offers";
    }
  }
}

function refreshOfferActivationUsage(force = false) {
  if (!offersFirstUiEnabled) return Promise.resolve();
  const isFresh =
    offerActivationUsageFetchedAt > 0
    && Date.now() - offerActivationUsageFetchedAt < OFFER_ACTIVATION_USAGE_REFRESH_MS;
  if (!force && isFresh) return Promise.resolve();
  if (offerActivationUsageRequest) return offerActivationUsageRequest;

  // Mark the attempt immediately so the fast operation-status poll cannot
  // create duplicate quota requests while this request is still in flight.
  offerActivationUsageFetchedAt = Date.now();
  offerActivationUsageRequest = chrome.runtime.sendMessage({
    type: "GET_OFFER_ACTIVATION_USAGE",
  }).catch(() => null).then((rawUsage) => {
    if (
      rawUsage
      && typeof rawUsage === "object"
      && typeof rawUsage.used === "number"
      && (rawUsage.limit === null || typeof rawUsage.limit === "number")
      && (rawUsage.remaining === null || typeof rawUsage.remaining === "number")
    ) {
      offerActivationUsage = {
        used: Math.max(0, rawUsage.used),
        limit: rawUsage.limit,
        remaining: rawUsage.remaining,
        accountLevel: rawUsage.accountLevel === "pro" ? "pro" : "free",
      };
      renderOfferActivationUsage();
    }
  }).finally(() => {
    offerActivationUsageRequest = null;
  });
  return offerActivationUsageRequest;
}

function renderOffersSetupHierarchy(snapshot: OfferOperationSnapshot) {
  const setup = getOffersSetupState(
    snapshot,
    firstSyncCompleted,
    guidedOfferIssuer,
  );
  if (setup.issuer) guidedOfferIssuer = setup.issuer;

  const recommendation = document.getElementById("offersRecommendation");
  const panel = document.getElementById("toolsTabPanel");
  const guidedSetupActive =
    offersFirstUiEnabled
    && !offersSetupCompleted
    && setup.stage !== "complete";
  if (recommendation) recommendation.hidden = !guidedSetupActive;
  panel?.classList.toggle("offers-guided-setup", guidedSetupActive);
  if (guidedSetupActive) {
    panel?.setAttribute("data-guided-stage", setup.stage);
  } else {
    panel?.removeAttribute("data-guided-stage");
  }

  const issuerActions = document.getElementById("offersIssuerActions");
  if (issuerActions) issuerActions.hidden = setup.stage !== "choose_issuer";
  const milestone = document.getElementById("offersSetupMilestone");
  if (milestone) milestone.hidden = setup.stage !== "sync_rewards";
  const setupActions = document.getElementById("offersSetupActions");
  if (setupActions) setupActions.hidden = setup.stage !== "choose_issuer";
  const rewardsActions = document.getElementById("offersSetupRewardsActions");
  if (rewardsActions) rewardsActions.hidden = setup.stage !== "sync_rewards";
  const operationIsRunning = Boolean(
    snapshot.active
    && snapshot.active.phase !== "ready_to_add",
  );
  const setupStatus = document.getElementById("offersSetupStatus");
  if (setupStatus) setupStatus.hidden = !operationIsRunning;
  const setupStatusText = document.getElementById("offersSetupStatusText");
  if (setupStatusText && snapshot.active) {
    setupStatusText.textContent = snapshot.active.phase === "adding"
      ? "You can close this popup while we finish."
      : "Keep the issuer tab open. You can come back anytime.";
  }
  const setupCancel = document.getElementById("offersSetupCancel");
  if (setupCancel && snapshot.active) {
    setupCancel.textContent = snapshot.active.phase === "adding"
      ? "Stop after this offer"
      : "Cancel";
  }

  for (const issuer of ["chase", "amex", "citi"] as const) {
    const showGuidedIssuer = (
      setup.stage === "check_offers" && !snapshot.active
    ) || (
      setup.stage === "review_offers"
      && setup.operation?.phase === "ready_to_add"
    );
    document
      .getElementById(`${issuer}OffersCard`)
      ?.classList.toggle(
        "guided-active-issuer",
        guidedSetupActive && showGuidedIssuer && guidedOfferIssuer === issuer,
      );
  }

  const title = document.getElementById("offersRecommendationTitle");
  const text = document.getElementById("offersRecommendationText");
  const eyebrow = document.getElementById("offersRecommendationEyebrow");
  const issuerName = setup.issuer === "amex"
    ? "Amex"
    : setup.issuer === "citi"
      ? "Citi"
      : "Chase";
  if (!title || !text) return;
  if (setup.stage === "check_offers") {
    const needsRetry =
      setup.operation?.phase === "failed"
      || setup.operation?.phase === "interrupted"
      || setup.operation?.phase === "cancelled";
    if (eyebrow) eyebrow.textContent = "Step 2 of 3";
    title.textContent = needsRetry
      ? `Try ${issuerName} again`
      : setup.operation && operationIsRunning
        ? getOfferOperationStatusText(setup.operation)
        : `Check your ${issuerName} card`;
    text.textContent = needsRetry
      ? "The check didn’t finish. Use the card below to try again."
      : "We’ll find the offers currently available on your card.";
  } else if (setup.stage === "review_offers") {
    if (eyebrow) eyebrow.textContent = "Step 3 of 3";
    title.textContent = setup.operation?.phase === "adding"
      ? getOfferOperationStatusText(setup.operation)
      : `Review your ${issuerName} offers`;
    text.textContent = setup.operation?.phase === "adding"
      ? "We’re activating your selections securely in the background."
      : "Choose a card, confirm the count, and add its offers.";
  } else if (setup.stage === "sync_rewards") {
    if (eyebrow) eyebrow.textContent = "Offers are ready";
    title.textContent = "One last step";
    text.textContent = "Connect one rewards program to keep your points, credits, and benefits together.";
  } else {
    if (eyebrow) eyebrow.textContent = "Step 1 of 3";
    title.textContent = "Choose a card issuer";
    text.textContent = "Start with one issuer. We’ll guide you through the rest.";
  }
}

async function refreshOfferOperationUi() {
  if (!offersFirstUiEnabled) return;
  void refreshOfferActivationUsage();
  const raw = await chrome.runtime.sendMessage({
    type: "GET_OFFER_OPERATION_STATUS",
  }).catch(() => null);
  const snapshot = normalizeOfferOperationSnapshot(raw);
  latestOfferSnapshot = snapshot;
  const active = snapshot.active;

  if (active) activeOfferRunIds.set(active.issuer, active.runId);
  updateIssuerCardStatus(snapshot);
  renderBackgroundOwnedIssuerState(snapshot);

  const activity = document.getElementById("offerActivity");
  const cancelButton = document.getElementById("offerActivityCancel") as HTMLButtonElement | null;
  if (activity) activity.hidden = !active;
  if (active) {
    renderOfferActivityMessage(
      getOfferOperationStatusText(active),
      active.phase === "adding"
        ? "You can keep using nextcard while this finishes."
        : "Keep the issuer tab open. You can return here at any time.",
    );
    if (cancelButton) {
      cancelButton.hidden = false;
      cancelButton.textContent = active.phase === "adding"
        ? "Stop after current offer"
        : "Cancel";
    }
  } else if (cancelButton) {
    cancelButton.hidden = true;
  }

  const setup = getOffersSetupState(snapshot, firstSyncCompleted, guidedOfferIssuer);
  if (isOffersSetupComplete(setup.stage) && !offersSetupCompleted) {
    offersSetupCompleted = true;
    if (offersSetupCompletedStorageKey) {
      void chrome.storage.local.set({ [offersSetupCompletedStorageKey]: true });
    }
  }

  renderOffersSetupHierarchy(snapshot);
  document.querySelectorAll<HTMLButtonElement>("[data-offer-issuer]").forEach((button) => {
    button.disabled = Boolean(active);
  });
  for (const issuer of ["chase", "amex", "citi", "capitalone"] as OfferIssuer[]) {
    const card = document.getElementById(`${issuer}OffersCard`);
    const shouldLockCard = Boolean(
      active
      && (
        active.issuer !== issuer
        || active.phase !== "ready_to_add"
      ),
    );
    card?.classList.toggle("offer-operation-locked", shouldLockCard);
    const action = document.getElementById(`${issuer}OffersDiscoverBtn`) as HTMLButtonElement | null;
    if (action) {
      action.disabled = Boolean(active);
      action.textContent =
        active?.issuer === issuer
          ? "Working"
          : active
            ? "Busy"
            : "Check";
    }
  }
}

function cancelActiveOfferOperation() {
  const active = latestOfferSnapshot.active;
  if (!active) return;
  void chrome.runtime.sendMessage({
    type: "CANCEL_OFFER_OPERATION",
    runId: active.runId,
  }).then(() => {
    activeOfferRunIds.delete(active.issuer);
    void refreshOfferOperationUi();
  });
}

document
  .getElementById("offerActivityCancel")
  ?.addEventListener("click", cancelActiveOfferOperation);
document
  .getElementById("offersSetupCancel")
  ?.addEventListener("click", cancelActiveOfferOperation);

document.querySelectorAll<HTMLButtonElement>("[data-offer-issuer]").forEach((button) => {
  button.addEventListener("click", () => {
    const issuer = button.dataset.offerIssuer as OfferIssuer;
    guidedOfferIssuer = issuer;
    renderOffersSetupHierarchy(latestOfferSnapshot);
    document.getElementById(`${issuer}OffersDiscoverBtn`)?.click();
  });
});

function completeOffersSetup() {
  offersSetupCompleted = true;
  if (offersSetupCompletedStorageKey) {
    void chrome.storage.local.set({ [offersSetupCompletedStorageKey]: true });
  }
  renderOffersSetupHierarchy(latestOfferSnapshot);
}

for (const id of ["offersSetupSkip", "offersSetupUnsupported"]) {
  document.getElementById(id)?.addEventListener("click", () => {
    completeOffersSetup();
    if (id === "offersSetupUnsupported") {
      (document.getElementById("offersMore") as HTMLDetailsElement | null)?.setAttribute("open", "");
    }
  });
}

document.getElementById("offersRewardsHandoffStart")?.addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Opening Rewards…";
  setDestination("rewards");
  syncTabPanel?.classList.remove("rewards-handoff-enter");
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
    syncTabPanel?.classList.add("rewards-handoff-enter");
    homeElements.tourTooltip.focus({ preventScroll: true });
  });
  window.setTimeout(() => {
    syncTabPanel?.classList.remove("rewards-handoff-enter");
    button.disabled = false;
    button.innerHTML = 'Continue to Rewards <span aria-hidden="true">→</span>';
  }, 520);
});

document.getElementById("offersRewardsHandoffDismiss")?.addEventListener("click", () => {
  completeOffersSetup();
});

document.getElementById("offersCoachmarkDismiss")?.addEventListener("click", () => {
  offersCoachmarkSeen = true;
  void chrome.storage.local.set({ offersCoachmarkSeen: true });
  const coachmark = document.getElementById("offersCoachmark");
  if (coachmark) coachmark.hidden = true;
});

function showView(name: ViewName) {
  for (const [key, element] of Object.entries(views)) {
    element.classList.toggle("active", key === name);
  }
  currentView = name;
}

function showNextcardAuthWait() {
  awaitingNextcardAuth = true;
  authElements.loadingLabel.textContent = "Connecting to nextcard…";
  authElements.loadingDetail.textContent = "Finish signing in in the tab that opened.";
  showView("loading");

  if (nextcardAuthWaitTimeout !== null) {
    window.clearTimeout(nextcardAuthWaitTimeout);
  }
  nextcardAuthWaitTimeout = window.setTimeout(() => {
    nextcardAuthWaitTimeout = null;
    if (!awaitingNextcardAuth || currentAuth) return;
    awaitingNextcardAuth = false;
    updateOnboardingSkipVisibility();
    showView("disclosure");
  }, NEXTCARD_AUTH_WAIT_TIMEOUT_MS);
}

function finishNextcardAuthWait() {
  awaitingNextcardAuth = false;
  if (nextcardAuthWaitTimeout !== null) {
    window.clearTimeout(nextcardAuthWaitTimeout);
    nextcardAuthWaitTimeout = null;
  }
  authElements.loadingLabel.textContent = "Loading nextcard…";
  authElements.loadingDetail.textContent = "";
}

for (const button of document.querySelectorAll("[data-back]")) {
  button.addEventListener("click", () => showView("home"));
}

for (const button of document.querySelectorAll(".wallet-btn")) {
  button.addEventListener("click", () => openRewards());
}

document.getElementById("homeOffersBtn")?.addEventListener("click", () => openOffers());
document.getElementById("homeRewardsBtn")?.addEventListener("click", () => openRewards());

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
  if (document.getElementById("offerLimitModal")?.classList.contains("visible")) {
    closeOfferLimitDialog({ restoreFocus: true });
    return;
  }
  if (document.getElementById("amexMultiEnrollDisclaimerModal")?.classList.contains("visible")) {
    closeAmexMultiEnrollDisclaimer({ restoreFocus: true });
    return;
  }
  if (document.getElementById("offerConfirmModal")?.classList.contains("visible")) {
    closeOfferConfirmation({ restoreFocus: true });
    return;
  }
  document
    .querySelectorAll(".info-popover.visible")
    .forEach((element) => element.classList.remove("visible"));
  document
    .querySelectorAll("[data-info-toggle][aria-expanded='true']")
    .forEach((button) => button.setAttribute("aria-expanded", "false"));
});

homeElements.congratsBtn.addEventListener("click", () => {
  homeElements.congratsBanner.classList.remove("visible");
  setDestination("rewards");
  showView("home");
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  getFinalLabel: () => replayingOnboarding
    ? "Back to Offers"
    : currentAuth
      ? "Continue to Offers"
      : "Continue with nextcard",
  onComplete: () => {
    replayingOnboarding = false;
    const replayClose = document.getElementById("onboardingReplayClose");
    if (replayClose) replayClose.hidden = true;
    const skipButton = document.getElementById("onboardingSkipBtn");
    if (skipButton) skipButton.hidden = true;
    disclosureAccepted = true;
    offersIntroVersion = CURRENT_OFFERS_INTRO_VERSION;
    offersCoachmarkSeen = true;
    chrome.storage.local.set({
      disclosureAccepted: true,
      offersIntroVersion: CURRENT_OFFERS_INTRO_VERSION,
      offersCoachmarkSeen: true,
      lastHomeDestination: "offers",
    });
    destinationRestored = true;
    setDestination("offers", { persist: false });
    if (currentAuth) {
      renderAuthState(currentAuth);
    } else {
      showNextcardAuthWait();
      chrome.runtime.sendMessage({ type: "SIGN_IN_NEXTCARD" });
    }
  },
});

const replayGuideButton = document.getElementById("onboardingReplayBtn");
const replayGuideClose = document.getElementById("onboardingReplayClose");
const onboardingSkipButton = document.getElementById("onboardingSkipBtn");

function updateOnboardingSkipVisibility() {
  if (!onboardingSkipButton) return;
  const returningSignedOutUser =
    !currentAuth
    && offersIntroVersion >= CURRENT_OFFERS_INTRO_VERSION;
  onboardingSkipButton.hidden =
    replayingOnboarding || !returningSignedOutUser;
}

function closeOnboardingReplay() {
  if (!replayingOnboarding) return;
  replayingOnboarding = false;
  if (replayGuideClose) replayGuideClose.hidden = true;
  updateOnboardingSkipVisibility();
  showView("home");
  requestAnimationFrame(() => replayGuideButton?.focus());
}

replayGuideButton?.addEventListener("click", () => {
  replayingOnboarding = true;
  onboardingController.reset();
  if (replayGuideClose) replayGuideClose.hidden = false;
  updateOnboardingSkipVisibility();
  showView("disclosure");
  requestAnimationFrame(() => replayGuideClose?.focus());
});

replayGuideClose?.addEventListener("click", closeOnboardingReplay);

onboardingSkipButton?.addEventListener("click", () => {
  onboardingSkipButton.hidden = true;
  showNextcardAuthWait();
  chrome.runtime.sendMessage({ type: "SIGN_IN_NEXTCARD" });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && replayingOnboarding) {
    closeOnboardingReplay();
  }
});

async function recordConsent() {
  chrome.runtime.sendMessage({
    type: "RECORD_CONSENT",
    consentType: "sync_privacy_v1",
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
  });
}

async function recordOfferConsent() {
  const response = await chrome.runtime.sendMessage({
    type: "RECORD_CONSENT",
    consentType: `offers_privacy_v${CURRENT_OFFER_CONSENT_VERSION}`,
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent: navigator.userAgent,
  }).catch(() => null) as { ok?: boolean } | null;
  return response?.ok === true;
}

async function startSyncFlow(
  providerId: ProviderId,
  options: { showViewOnStart: boolean },
) {
  if (!firstSyncCompleted || rewardsGuideQaPreviewActive) {
    tourSyncProvider = providerId;
    tourSyncBaselineLastSyncedAt =
      latestProviderStates?.[providerId]?.lastSyncedAt ?? null;
    tourSyncObservedInProgress = false;
  }
  rewardsGuideQaPreviewActive = false;

  const started = await startProviderSync(providerId);
  if (!started && tourSyncProvider === providerId) {
    tourSyncProvider = null;
    tourSyncBaselineLastSyncedAt = null;
    tourSyncObservedInProgress = false;
  }
  if (started && options.showViewOnStart) {
    showView(providerId);
  }

  return started;
}

const consentController = createConsentController({
  ...consentElements,
  onContinue: (providerId) => {
    markConsentAccepted();
    void startSyncFlow(providerId, { showViewOnStart: true });
  },
  onActionContinue: (action) => {
    action();
  },
});

function markConsentAccepted() {
  consentGiven = true;
  chrome.storage.local.set({ consentGiven: true });
  void recordConsent();
}

function requestToolConsent(action: () => void) {
  if (!consentGiven) {
    consentController.requestAction(() => {
      markConsentAccepted();
      action();
    });
    return false;
  }

  action();
  return true;
}

function requestOfferToolAction(action: () => void) {
  if (
    offersFirstUiEnabled
    && offerConsentVersion >= CURRENT_OFFER_CONSENT_VERSION
  ) {
    action();
    return true;
  }
  return requestToolConsent(action);
}

async function requestSync(providerId: ProviderId) {
  if (
    extensionProfile?.accountLevel === "free"
    && extensionProfile.lockedProviders.includes(providerId)
  ) {
    handleLockedProviderSelected(providerId);
    return false;
  }

  if (!consentGiven) {
    consentController.request(providerId);
    return false;
  }

  return startSyncFlow(providerId, { showViewOnStart: false });
}

function handleProviderSelected(providerId: ProviderId) {
  if (
    extensionProfile?.accountLevel === "free"
    && extensionProfile.lockedProviders.includes(providerId)
  ) {
    handleLockedProviderSelected(providerId);
    return;
  }

  if (!firstSyncCompleted || rewardsGuideQaPreviewActive) {
    void requestSync(providerId);
    return;
  }

  showView(providerId);
}

let upgradeRequestInFlight = false;
let lastUpgradeRequestAt = 0;

function handleLockedProviderSelected(_providerId: ProviderId) {
  const now = Date.now();
  if (upgradeRequestInFlight || now - lastUpgradeRequestAt < 1000) {
    return;
  }

  upgradeRequestInFlight = true;
  lastUpgradeRequestAt = now;
  chrome.runtime.sendMessage({ type: "OPEN_UPGRADE" }, () => {
    upgradeRequestInFlight = false;
  });
  setTimeout(() => {
    upgradeRequestInFlight = false;
  }, 2500);
}

const renderHome = createHomeRenderer({
  providerList: homeElements.providerList,
  tourTooltip: homeElements.tourTooltip,
  getFirstSyncCompleted: () => firstSyncCompleted,
  getRewardsGuidePreview: () => rewardsGuideQaPreviewActive,
  getExtensionProfile: () => extensionProfile,
  markFirstSyncCompleted: () => {
    firstSyncCompleted = true;
    chrome.storage.local.set({ firstSyncCompleted: true });
    renderOffersSetupHierarchy(latestOfferSnapshot);
  },
  onProviderSelected: handleProviderSelected,
  onLockedProviderSelected: handleLockedProviderSelected,
});

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
let signedOutPollCount = 0;

function renderPlanBadge() {
  let badge = document.getElementById("userPlanBadge") as HTMLSpanElement | null;
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "userPlanBadge";
    badge.className = "user-plan-badge";
    authElements.userEmail.insertAdjacentElement("afterend", badge);
  }

  const isPro = extensionProfile?.accountLevel === "pro";
  badge.textContent = isPro ? "Pro" : "Free";
  badge.classList.toggle("pro", isPro);
}

function renderAuthState(auth: NextCardAuth | null) {
  if (!flagsLoaded) return;
  currentAuth = auth;
  updateOnboardingSkipVisibility();

  if (!auth) {
    if (awaitingNextcardAuth) return;
    if (renderedAccountKey !== null) {
      resetOfferAccountUi();
      renderedAccountKey = null;
    }
    // Don't flash the disclosure view on first load — service worker may still be waking up.
    // Only show disclosure after a poll confirms auth is truly null.
    if (!authConfirmed) return;
    if (currentView !== "disclosure") {
      onboardingController.reset();
      showView("disclosure");
    }
    return;
  }
  finishNextcardAuthWait();
  const nextOffersSetupStorageKey = getOffersSetupCompletedStorageKey(auth);
  if (offersSetupCompletedStorageKey !== nextOffersSetupStorageKey) {
    offersSetupCompletedStorageKey = nextOffersSetupStorageKey;
    offersSetupCompleted = false;
    if (nextOffersSetupStorageKey) {
      void chrome.storage.local.get(nextOffersSetupStorageKey).then((stored) => {
        if (offersSetupCompletedStorageKey !== nextOffersSetupStorageKey) return;
        offersSetupCompleted = stored[nextOffersSetupStorageKey] === true;
        renderOffersSetupHierarchy(latestOfferSnapshot);
      });
    }
  }
  const accountKey = `${auth.email ?? ""}:${auth.signedInAt}`;
  if (renderedAccountKey !== null && renderedAccountKey !== accountKey) {
    resetOfferAccountUi();
  }
  renderedAccountKey = accountKey;
  authConfirmed = true;
  applyOffersFirstMode(extensionProfile);

  const needsOffersIntro =
    offersFirstUiEnabled
    && offersIntroVersion < CURRENT_OFFERS_INTRO_VERSION;
  if (!disclosureAccepted || needsOffersIntro) {
    onboardingElements.onboardingBtn.textContent = auth
      ? "Continue to Offers"
      : "Continue with nextcard";
    if (currentView !== "disclosure") {
      showView("disclosure");
    }
    return;
  }

  authElements.userAvatar.textContent = getInitials(auth.name);
  authElements.userName.textContent = auth.name ?? "nextcard user";
  authElements.userEmail.textContent = auth.email ?? "";
  renderPlanBadge();

  // Show tab bar when signed in
  if (tabBar) tabBar.classList.remove("hidden");

  if (
    currentView === "loading"
    || currentView === "auth"
    || (currentView === "disclosure" && !replayingOnboarding)
  ) {
    showView("home");
  }

  renderOffersSetupHierarchy(latestOfferSnapshot);
  const coachmark = document.getElementById("offersCoachmark");
  if (coachmark) {
    coachmark.hidden = !offersFirstUiEnabled || offersCoachmarkSeen || offersIntroVersion === 0;
  }
  void refreshOfferOperationUi();
}

authElements.authSignInBtn.addEventListener("click", () => {
  showNextcardAuthWait();
  chrome.runtime.sendMessage({ type: "SIGN_IN_NEXTCARD" });
});

authElements.userSignOutBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "SIGN_OUT_NEXTCARD" }, () => {
    disclosureAccepted = false;
    consentGiven = false;
    firstSyncCompleted = false;
    tourSyncProvider = null;
    tourSyncBaselineLastSyncedAt = null;
    tourSyncObservedInProgress = false;
    latestProviderStates = null;
    offersSetupCompleted = false;
    offersSetupCompletedStorageKey = null;
    offerConsentVersion = 0;
    extensionProfile = null;
    currentAuth = null;
    finishNextcardAuthWait();
    resetOfferAccountUi();
    renderedAccountKey = null;
    onboardingController.reset();
    updateOnboardingSkipVisibility();
    showView("disclosure");
  });
});

function maybeShowCongratsBanner(allStates: Record<ProviderId, ProviderSyncState>) {
  if (!tourSyncProvider) {
    return;
  }

  const state = allStates[tourSyncProvider];
  if (
    state?.status === "detecting_login"
    || state?.status === "waiting_for_login"
    || state?.status === "extracting"
  ) {
    tourSyncObservedInProgress = true;
    return;
  }
  if (state?.status === "error" || state?.status === "cancelled") {
    tourSyncProvider = null;
    tourSyncBaselineLastSyncedAt = null;
    tourSyncObservedInProgress = false;
    return;
  }

  const hasFreshCompletion =
    state?.status === "done"
    && (
      tourSyncObservedInProgress
      || state.lastSyncedAt !== tourSyncBaselineLastSyncedAt
    );
  if (!hasFreshCompletion) return;

  const providerId = tourSyncProvider;
  tourSyncProvider = null;
  tourSyncBaselineLastSyncedAt = null;
  tourSyncObservedInProgress = false;
  firstSyncCompleted = true;
  chrome.storage.local.set({ firstSyncCompleted: true });
  renderOffersSetupHierarchy(latestOfferSnapshot);
  showView(providerId);
  homeElements.congratsBanner.classList.add("visible");
}

function updateActiveWalletButton(allStates: Record<ProviderId, ProviderSyncState>) {
  if (
    currentView === "loading"
    || currentView === "home"
    || currentView === "auth"
    || currentView === "disclosure"
  ) {
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
    if (!snapshot.auth && !authConfirmed) {
      signedOutPollCount += 1;
      if (signedOutPollCount < SIGNED_OUT_CONFIRMATION_POLLS) return;
    } else if (snapshot.auth) {
      signedOutPollCount = 0;
    }
    authConfirmed = true;
    extensionProfile = snapshot.extensionProfile;
    renderAuthState(snapshot.auth);
    if (!snapshot.auth || !snapshot.allStates) return;

    latestProviderStates = snapshot.allStates;
    renderHome(snapshot.allStates);
    renderAllProviders(snapshot.allStates);
    updateActiveWalletButton(snapshot.allStates);
    maybeShowCongratsBanner(snapshot.allStates);
  } catch {
    // The service worker can be asleep when the popup first opens, so polling stays best-effort.
  }
}

async function initializePopup() {
  if (__REWARDS_GUIDE_QA_PREVIEW__) {
    const qaResetState = await chrome.storage.local.get("fullFlowQaResetVersion");
    if (qaResetState.fullFlowQaResetVersion !== CURRENT_FULL_FLOW_QA_RESET_VERSION) {
      const stored = await chrome.storage.local.get(null);
      const resetKeys = Object.keys(stored).filter((key) => (
        key === "disclosureAccepted"
        || key === "consentGiven"
        || key === "firstSyncCompleted"
        || key === "offerConsentVersion"
        || key === "offersIntroVersion"
        || key === "offersIntroQaResetVersion"
        || key === "offersCoachmarkSeen"
        || key === "offersSetupCompleted"
        || key === "lastHomeDestination"
        || key === "pendingDestination"
        || key === "pendingTab"
        || key === "nextcard_offer_operation_snapshot_v1"
        || key.startsWith("offersSetupCompleted:")
      ));
      if (resetKeys.length > 0) {
        await chrome.storage.local.remove(resetKeys);
      }
      await chrome.storage.local.set({
        fullFlowQaResetVersion: CURRENT_FULL_FLOW_QA_RESET_VERSION,
      });
    }
  }

  const [flags, initialSnapshot, uiState] = await Promise.all([
    loadOnboardingFlags(),
    loadInitialPopupState(),
    chrome.storage.local.get([
      "offersIntroVersion",
      "offersSetupCompleted",
      "offersCoachmarkSeen",
      "offerConsentVersion",
      "offersIntroQaResetVersion",
    ]),
  ]);

  disclosureAccepted = flags.disclosureAccepted;
  consentGiven = flags.consentGiven;
  firstSyncCompleted = flags.firstSyncCompleted;
  offersSetupCompletedStorageKey =
    getOffersSetupCompletedStorageKey(initialSnapshot.auth);
  if (offersSetupCompletedStorageKey) {
    const scopedSetupState =
      await chrome.storage.local.get(offersSetupCompletedStorageKey);
    offersSetupCompleted =
      scopedSetupState[offersSetupCompletedStorageKey] === true;
    if (!offersSetupCompleted && uiState.offersSetupCompleted === true) {
      offersSetupCompleted = true;
      await chrome.storage.local.set({
        [offersSetupCompletedStorageKey]: true,
      });
    }
  }
  if (Object.prototype.hasOwnProperty.call(uiState, "offersSetupCompleted")) {
    await chrome.storage.local.remove("offersSetupCompleted");
  }
  offersCoachmarkSeen = uiState.offersCoachmarkSeen === true;
  offerConsentVersion =
    typeof uiState.offerConsentVersion === "number" ? uiState.offerConsentVersion : 0;
  offersIntroVersion =
    typeof uiState.offersIntroVersion === "number" ? uiState.offersIntroVersion : 0;
  if (
    __OFFERS_FIRST_UI_DEV_OVERRIDE__
    && uiState.offersIntroQaResetVersion !== CURRENT_OFFERS_INTRO_VERSION
  ) {
    offersIntroVersion = 0;
    offersCoachmarkSeen = false;
    await chrome.storage.local.set({
      offersIntroVersion: 0,
      offersCoachmarkSeen: false,
      offersIntroQaResetVersion: CURRENT_OFFERS_INTRO_VERSION,
    });
  }
  extensionProfile = initialSnapshot.extensionProfile;
  flagsLoaded = true;

  subscribeToOnboardingFlags((patch) => {
    if (patch.disclosureAccepted != null) disclosureAccepted = patch.disclosureAccepted;
    if (patch.consentGiven != null) consentGiven = patch.consentGiven;
    if (patch.firstSyncCompleted != null) firstSyncCompleted = patch.firstSyncCompleted;
  });

  renderAuthState(initialSnapshot.auth);
  if (initialSnapshot.auth) {
    latestProviderStates = initialSnapshot.allStates;
    renderHome(initialSnapshot.allStates);
    renderAllProviders(initialSnapshot.allStates);
    updateActiveWalletButton(initialSnapshot.allStates);
  }

  setInterval(() => {
    void refreshPopupState();
  }, 500);
}

void initializePopup();
