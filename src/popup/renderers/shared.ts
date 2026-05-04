import type { ProviderId, ProviderSyncState, SyncStatus } from "../../lib/types";

const confirmModal = document.getElementById("confirmModal") as HTMLDivElement;
const confirmModalTitle = document.getElementById("confirmModalTitle") as HTMLDivElement;
const confirmModalCancel = document.getElementById("confirmModalCancel") as HTMLButtonElement;
const confirmModalConfirm = document.getElementById("confirmModalConfirm") as HTMLButtonElement;

// Keep the extension's wallet CTA aligned with the current NextCard dashboard route.
export const WALLET_URL = `${__NEXTCARD_URL__}/dashboard/wallet`;
export const REWARDS_URL = `${__NEXTCARD_URL__}/dashboard/rewards`;

const SUPPORT_EMAIL = "help@nextcard.com";

export const STATUS_LABELS: Record<SyncStatus, string> = {
  idle: "Ready to sync",
  detecting_login: "Opening...",
  waiting_for_login: "Waiting for sign in",
  extracting: "Syncing your account...",
  done: "Sync complete",
  cancelled: "Sync cancelled",
  error: "Something went wrong",
};

export const STATUS_SUBTITLES: Record<SyncStatus, string> = {
  idle: "",
  detecting_login: "",
  waiting_for_login: "",
  extracting:
    "Sit tight — we're navigating your account pages. Please don't close or switch the tab.",
  done: "",
  cancelled: "",
  error: "",
};

export const STATUS_DOT_CLASS: Record<SyncStatus, string> = {
  idle: "idle",
  detecting_login: "waiting",
  waiting_for_login: "waiting",
  extracting: "extracting",
  done: "done",
  cancelled: "idle",
  error: "error",
};

// Shared modal wiring keeps every detail renderer using the same delete confirmation flow.
export function showConfirmDelete(providerName: string) {
  return new Promise<boolean>((resolve) => {
    confirmModalTitle.textContent = `Delete ${providerName} data?`;
    confirmModal.classList.add("visible");

    function cleanup() {
      confirmModal.classList.remove("visible");
      confirmModalCancel.removeEventListener("click", onCancel);
      confirmModalConfirm.removeEventListener("click", onConfirm);
    }

    function onCancel() {
      cleanup();
      resolve(false);
    }

    function onConfirm() {
      cleanup();
      resolve(true);
    }

    confirmModalCancel.addEventListener("click", onCancel);
    confirmModalConfirm.addEventListener("click", onConfirm);
  });
}

export function openWallet() {
  chrome.tabs.create({ url: WALLET_URL });
}

export function openRewards() {
  chrome.tabs.create({ url: REWARDS_URL });
}

export function updateWalletBtn(providerId: string, status: string) {
  const btn = document.getElementById(`${providerId}WalletBtn`);
  if (btn) {
    btn.style.display = status === "done" ? "block" : "none";
    btn.textContent = "View on nextcard";
  }
}

export function formatRelativeTime(isoDate: string | null) {
  if (!isoDate) return null;
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

export function escapeHtml(str: string) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function buildIssueReportMailto(
  providerName: string,
  providerId: string,
  status: SyncStatus,
  error: string | null,
) {
  const version = chrome.runtime.getManifest().version;
  const body = [
    "Tell us what happened:",
    "",
    "",
    "---",
    `Provider: ${providerName} (${providerId})`,
    `Status: ${status}`,
    `Extension version: ${version}`,
    error ? `Error: ${error}` : null,
  ]
    .filter((line): line is string => line != null)
    .join("\n");

  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Issue Report: nextcard sync")}&body=${encodeURIComponent(body)}`;
}

export function renderIssueReportHtml(
  providerName: string,
  providerId: string,
  status: SyncStatus,
  error: string | null,
) {
  if (status !== "error" && status !== "cancelled") {
    return "";
  }

  const mailto = buildIssueReportMailto(providerName, providerId, status, error);
  return `
    <div class="issue-report">
      <button class="issue-report-btn" type="button" data-issue-report-mailto="${escapeHtml(mailto)}">
        Report issue
      </button>
      <span class="issue-report-email">${SUPPORT_EMAIL}</span>
    </div>
  `;
}

export function formatTerms(raw: string) {
  let cleaned = raw.trim();
  const discountIdx = cleaned.search(/Discount:\s/i);
  if (discountIdx > 0) {
    cleaned = cleaned.slice(discountIdx);
  }

  let blocks = cleaned
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length <= 1) {
    blocks = cleaned
      .replace(/\.\s+(?=[A-Z])/g, ".\n\n")
      .replace(/:\s+(?=[A-Z])/g, ":\n\n")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
  }

  return blocks.map((block) => `<p>${escapeHtml(block)}</p>`).join("");
}

export function renderValue(el: HTMLDivElement, value: string | null) {
  if (value) {
    el.textContent = value;
    el.classList.remove("empty");
    return;
  }

  el.textContent = "--";
  el.classList.add("empty");
}

export interface AirlineEls {
  statusDot: HTMLDivElement;
  statusText: HTMLSpanElement;
  statusSubtitle: HTMLDivElement;
  lastSynced: HTMLDivElement;
  syncBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  errorContainer: HTMLDivElement;
  loginPrompt: HTMLDivElement;
  dataSection: HTMLDivElement;
  rawToggle: HTMLButtonElement;
  rawData: HTMLDivElement;
  milesBalance: HTMLDivElement;
  eliteStatus: HTMLDivElement;
  memberInfo: HTMLDivElement;
  extraFields: Record<string, HTMLDivElement>;
}

export function getAirlineEls(prefix: string, extraFieldIds: string[]): AirlineEls {
  const div = (id: string) => document.getElementById(id) as HTMLDivElement;
  const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
  const extraFields: Record<string, HTMLDivElement> = {};

  for (const fieldId of extraFieldIds) {
    extraFields[fieldId] = div(
      `${prefix}${fieldId.charAt(0).toUpperCase() + fieldId.slice(1)}`,
    );
  }

  return {
    statusDot: div(`${prefix}StatusDot`),
    statusText: document.getElementById(`${prefix}StatusText`) as HTMLSpanElement,
    statusSubtitle: div(`${prefix}StatusSubtitle`),
    lastSynced: div(`${prefix}LastSynced`),
    syncBtn: btn(`${prefix}SyncBtn`),
    cancelBtn: btn(`${prefix}CancelBtn`),
    clearBtn: btn(`${prefix}ClearBtn`),
    errorContainer: div(`${prefix}ErrorContainer`),
    loginPrompt: div(`${prefix}LoginPrompt`),
    dataSection: div(`${prefix}DataSection`),
    rawToggle: btn(`${prefix}RawToggle`),
    rawData: div(`${prefix}RawData`),
    milesBalance: div(`${prefix}MilesBalance`),
    eliteStatus: div(`${prefix}EliteStatus`),
    memberInfo: div(`${prefix}MemberInfo`),
    extraFields,
  };
}

export function renderAirline<T extends Record<string, unknown>>(
  els: AirlineEls,
  state: ProviderSyncState<T>,
  providerId: ProviderId,
  providerName: string,
  lastJson: { value: string },
  extraRenderer?: (data: T, els: AirlineEls) => void,
) {
  const json = JSON.stringify(state);
  if (json === lastJson.value) return;
  lastJson.value = json;

  const { status, data, error, lastSyncedAt, progressMessage } = state;
  els.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
  els.statusText.textContent = STATUS_LABELS[status];

  const isBusy =
    status === "extracting"
    || status === "detecting_login"
    || status === "waiting_for_login";
  els.statusSubtitle.textContent =
    isBusy && progressMessage ? progressMessage : STATUS_SUBTITLES[status];
  els.syncBtn.disabled = isBusy;
  els.syncBtn.textContent = isBusy
    ? "Syncing..."
    : status === "done" || status === "cancelled"
      ? "Sync Again"
      : `Sync ${providerName}`;
  els.cancelBtn.style.display = isBusy ? "block" : "none";
  els.clearBtn.style.display = data && !isBusy ? "block" : "none";
  els.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

  const relative = formatRelativeTime(lastSyncedAt);
  if (relative) {
    els.lastSynced.textContent = `Last synced ${relative}`;
    els.lastSynced.style.display = "block";
  } else {
    els.lastSynced.style.display = "none";
  }

  els.errorContainer.innerHTML = error
    ? `<div class="error-msg">${escapeHtml(error)}</div>${renderIssueReportHtml(providerName, providerId, status, error)}`
    : renderIssueReportHtml(providerName, providerId, status, null);

  if (!data || typeof data !== "object") {
    els.dataSection.style.display = "none";
    els.rawToggle.style.display = "none";
    return;
  }

  els.dataSection.style.display = "block";
  const balanceValue = data.milesBalance ?? data.pointsBalance;
  renderValue(
    els.milesBalance,
    typeof balanceValue === "number" ? balanceValue.toLocaleString() : null,
  );
  renderValue(
    els.eliteStatus,
    typeof data.eliteStatus === "string" ? data.eliteStatus : null,
  );

  const memberParts = [data.memberName, data.memberNumber].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  renderValue(els.memberInfo, memberParts.length > 0 ? memberParts.join(" - ") : null);

  if (extraRenderer) {
    extraRenderer(data, els);
  }

  els.rawToggle.style.display = "block";
  els.rawData.textContent = JSON.stringify(data, null, 2);
}

export function wireAirlineEvents(
  els: AirlineEls,
  providerId: ProviderId,
  providerName: string,
  requestSync: (providerId: ProviderId) => Promise<boolean>,
  renderSyncingState: () => void,
) {
  els.syncBtn.addEventListener("click", () => {
    void requestSync(providerId).then((started) => {
      if (started) {
        renderSyncingState();
      }
    });
  });

  els.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: providerId });
  });

  els.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete(providerName)) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: providerId });
    }
  });

  els.rawToggle.addEventListener("click", () => {
    els.rawData.classList.toggle("visible");
    els.rawToggle.textContent = els.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });
}
