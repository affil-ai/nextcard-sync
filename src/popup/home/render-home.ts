import type {
  ExtensionProfile,
  ExtensionRewardsSummary,
  ProviderId,
  ProviderSyncState,
} from "../../lib/types";
import {
  formatRewardsSummaryBalance,
  getRewardsSummaryMeta,
} from "../../lib/rewards-summary";
import { orderedProviderIds, providerGroups } from "../../providers/provider-groups";
import {
  getProviderIconUrl,
  providerRegistry,
} from "../../providers/provider-registry";
import { escapeHtml, formatRelativeTime } from "../renderers/shared";
import {
  getConnectedTravelProviderIds,
  hasConnectedRewards,
  type RewardsSyncAllState,
} from "./home-state";

export function buildHomeSnapshot(
  allStates: Record<ProviderId, ProviderSyncState>,
  rewardsSummaries: ExtensionRewardsSummary[],
  firstSyncCompleted: boolean,
  extensionProfile: ExtensionProfile | null,
  previewRewardsGuide = false,
  syncAllState?: RewardsSyncAllState,
) {
  return orderedProviderIds
    .map((providerId) => {
      const state = allStates[providerId];
      return [
        providerId,
        state?.status ?? "idle",
        state?.progressMessage ?? "",
        state?.error ?? "",
        state?.backendSyncError ?? "",
        state?.lastSyncedAt ?? "",
        state?.backendSyncStatus ?? "",
        state?.pendingBackendPush ? "pending" : "",
        state?.accountPreparation?.attemptId ?? "",
        state?.accountPreparation?.memberDisplayName ?? "",
      ].join(":");
    })
    .join("|")
    + `|summaries:${JSON.stringify(rewardsSummaries)}`
    + `|tour:${firstSyncCompleted}|preview:${previewRewardsGuide}|plan:${extensionProfile?.accountLevel ?? "unknown"}|locked:${extensionProfile?.lockedProviders.join(",") ?? ""}`
    + `|syncAll:${syncAllState?.status ?? "idle"}:${syncAllState?.currentProviderId ?? ""}:${syncAllState?.processedCount ?? 0}:${syncAllState?.failedCount ?? 0}`;
}

export function createHomeRenderer(options: {
  providerList: HTMLDivElement;
  tourTooltip: HTMLDivElement;
  getFirstSyncCompleted: () => boolean;
  getRewardsGuidePreview?: () => boolean;
  getExtensionProfile: () => ExtensionProfile | null;
  getRewardsSummaries: () => ExtensionRewardsSummary[];
  getSyncAllState: () => RewardsSyncAllState;
  markFirstSyncCompleted: () => void;
  onProviderSelected: (providerId: ProviderId) => void;
  onLockedProviderSelected: (providerId: ProviderId) => void;
  onSummarySelected: (summary: ExtensionRewardsSummary) => void;
  onSummarySyncRequested: (providerId: ProviderId) => void;
  onSummaryCancelRequested: (providerId: ProviderId) => void;
  onAccountReady: (providerId: ProviderId, attemptId: string) => Promise<boolean>;
  onSyncAllRequested: (providerIds: ProviderId[]) => void;
  onSyncAllCancelRequested: () => void;
}) {
  let lastHomeSnapshot = "";

  function createStopButton(providerId: ProviderId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rewards-sync-stop";
    button.title = "Stop sync";
    button.setAttribute("aria-label", `Stop ${providerRegistry[providerId].name} sync`);
    button.textContent = "Stop";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      options.onSummaryCancelRequested(providerId);
    });
    return button;
  }

  return (allStates: Record<ProviderId, ProviderSyncState>) => {
    const firstSyncCompleted = options.getFirstSyncCompleted();
    const previewRewardsGuide = options.getRewardsGuidePreview?.() ?? false;
    const extensionProfile = options.getExtensionProfile();
    const rewardsSummaries = options.getRewardsSummaries();
    const syncAllState = options.getSyncAllState();
    const connectedRewards = hasConnectedRewards(
      allStates,
      rewardsSummaries,
      firstSyncCompleted,
    );
    const lockedProviders = new Set(extensionProfile?.lockedProviders ?? []);
    const snapshot = buildHomeSnapshot(
      allStates,
      rewardsSummaries,
      firstSyncCompleted,
      extensionProfile,
      previewRewardsGuide,
      syncAllState,
    );
    if (snapshot === lastHomeSnapshot) return;
    lastHomeSnapshot = snapshot;

    options.providerList.innerHTML = "";

    const summarizedProviders = new Set(
      rewardsSummaries.map((summary) => summary.provider),
    );
    if (rewardsSummaries.length > 0) {
      const travelProviderIds = getConnectedTravelProviderIds(
        rewardsSummaries,
        extensionProfile?.lockedProviders ?? [],
      );
      const travelSyncInProgress = travelProviderIds.some((providerId) => {
        const status = allStates[providerId]?.status;
        return (
          status === "extracting"
          || status === "detecting_login"
          || status === "waiting_for_login"
        );
      });
      const heading = document.createElement("div");
      heading.className = "rewards-summary-heading tour-target";
      const groupLabel = document.createElement("div");
      groupLabel.className = "home-section-label";
      groupLabel.textContent = "Your rewards";
      heading.appendChild(groupLabel);

      if (travelProviderIds.length > 1 || syncAllState.status === "running") {
        const actions = document.createElement("div");
        actions.className = "rewards-sync-all-actions";
        const syncAllButton = document.createElement("button");
        syncAllButton.className = "rewards-sync-all-btn";
        syncAllButton.type = "button";
        syncAllButton.setAttribute(
          "aria-label",
          `Sync all ${travelProviderIds.length} connected airline and hotel programs`,
        );
        syncAllButton.disabled =
          syncAllState.status === "running" || travelSyncInProgress;
        syncAllButton.textContent = syncAllState.status === "running"
          ? `Syncing ${syncAllState.processedCount + 1} of ${syncAllState.providerIds.length}…`
          : travelSyncInProgress
            ? "Sync in progress"
            : "Sync travel";
        syncAllButton.addEventListener("click", () =>
          options.onSyncAllRequested(travelProviderIds)
        );
        actions.appendChild(syncAllButton);
        if (syncAllState.status === "running") {
          const cancelButton = document.createElement("button");
          cancelButton.className = "rewards-sync-all-cancel";
          cancelButton.type = "button";
          cancelButton.textContent = "Cancel all";
          cancelButton.addEventListener("click", options.onSyncAllCancelRequested);
          actions.appendChild(cancelButton);
        }
        heading.appendChild(actions);
      }
      options.providerList.appendChild(heading);

      if (syncAllState.status !== "idle") {
        const progress = document.createElement("div");
        progress.className = syncAllState.failedCount > 0
          ? "rewards-sync-all-status has-error"
          : "rewards-sync-all-status";
        progress.setAttribute("role", "status");
        progress.setAttribute("aria-live", "polite");
        if (syncAllState.status === "running" && syncAllState.currentProviderId) {
          progress.textContent = `Syncing ${syncAllState.processedCount + 1} of ${syncAllState.providerIds.length}: ${providerRegistry[syncAllState.currentProviderId].name}.`;
        } else if (syncAllState.status === "cancelled") {
          progress.textContent = syncAllState.processedCount === 0
            ? "Travel sync cancelled."
            : `Travel sync cancelled after ${syncAllState.processedCount} of ${syncAllState.providerIds.length} programs.`;
        } else {
          const succeededCount = syncAllState.processedCount - syncAllState.failedCount;
          progress.textContent = syncAllState.failedCount === 0
            ? `All ${succeededCount} travel programs are up to date.`
            : `Synced ${succeededCount} of ${syncAllState.processedCount} travel programs. ${syncAllState.failedCount} ${syncAllState.failedCount === 1 ? "needs" : "need"} attention.`;
        }
        options.providerList.appendChild(progress);
      }

      for (const summary of rewardsSummaries) {
        const state = allStates[summary.provider];
        const definition = providerRegistry[summary.provider];
        const card = document.createElement("article");
        card.className = "rewards-summary-card";
        card.dataset.syncProvider = summary.provider;
        const isSyncing =
          state?.status === "extracting"
          || state?.status === "detecting_login"
          || state?.status === "waiting_for_login";
        card.classList.toggle("is-syncing", isSyncing);
        const isSyncAllRunning = syncAllState.status === "running";
        const hasError =
          state?.pendingBackendPush
          || state?.status === "error"
          || state?.backendSyncStatus === "partial";
        const awaitingConfirmation = state?.status === "awaiting_confirmation";
        const dotClass = isSyncing
          ? "syncing"
          : awaitingConfirmation
            ? "attention"
            : hasError
              ? "error"
              : "done";
        const balance = formatRewardsSummaryBalance(summary);
        const meta = getRewardsSummaryMeta(summary);
        const lastSyncedAt = state?.lastSyncedAt ?? summary.lastSyncedAt;
        const lastSync = formatRelativeTime(lastSyncedAt);
        const iconUrl = summary.iconUrl
          ? new URL(summary.iconUrl, __NEXTCARD_URL__).toString()
          : getProviderIconUrl(summary.provider);
        const providerLabel =
          definition.name === summary.programName ? null : definition.name;

        card.innerHTML = `
          <div class="rewards-summary-header">
            <div class="provider-icon"><img src="${escapeHtml(iconUrl)}" alt="" /></div>
            <div class="rewards-summary-title">
              <strong>${escapeHtml(summary.programName)}</strong>
              ${providerLabel ? `<span>${escapeHtml(providerLabel)}</span>` : ""}
            </div>
            ${!isSyncing ? `<div class="provider-status-dot ${dotClass}" aria-label="${awaitingConfirmation ? "Ready to confirm" : hasError ? "Needs attention" : "Synced"}"></div>` : ""}
          </div>
          <div class="rewards-summary-body">
            ${balance ? `<strong class="rewards-summary-balance" aria-label="Balance ${escapeHtml(balance)}">${escapeHtml(balance)}</strong>` : ""}
            ${summary.statusLevel ? `<span class="rewards-summary-status">${escapeHtml(summary.statusLevel)}</span>` : ""}
            ${meta ? `<div class="rewards-summary-meta">${escapeHtml(meta)}</div>` : ""}
            <div class="provider-last-sync">${awaitingConfirmation ? "Not saved yet · Confirm the account below" : `Synced ${lastSync ?? "recently"}`}</div>
          </div>
          <div class="rewards-summary-actions">
            ${!isSyncing && !awaitingConfirmation ? `<button class="rewards-summary-primary rewards-summary-sync" type="button"${isSyncAllRunning ? " disabled" : ""}>${hasError ? "Try again" : "Sync again"}</button>` : ""}
            <button class="rewards-summary-secondary rewards-summary-details" type="button">View details <span aria-hidden="true">→</span></button>
          </div>
        `;

        appendSyncProgress(card, state, summary.provider, options.onAccountReady);
        const actions = card.querySelector(".rewards-summary-actions");
        if (actions) card.appendChild(actions);
        if (isSyncing) card.querySelector(".rewards-summary-header")?.appendChild(createStopButton(summary.provider));
        card
          .querySelector<HTMLButtonElement>(".rewards-summary-details")
          ?.addEventListener("click", () => options.onSummarySelected(summary));
        card
          .querySelector<HTMLButtonElement>(".rewards-summary-sync")
          ?.addEventListener("click", () => options.onSummarySyncRequested(summary.provider));
        options.providerList.appendChild(card);
      }
    }

    for (const group of providerGroups) {
      const availableProviderIds = group.ids.filter(
        (providerId) => !summarizedProviders.has(providerId),
      );
      if (availableProviderIds.length === 0) continue;

      const groupLabel = document.createElement("div");
      groupLabel.className = "home-section-label";
      if (group.label === "Banks") {
        groupLabel.classList.add("tour-target");
      }
      groupLabel.style.marginTop = rewardsSummaries.length > 0 ? "20px" : "16px";
      groupLabel.textContent =
        rewardsSummaries.length > 0
          ? `Connect ${group.label.toLowerCase()}`
          : group.label;
      options.providerList.appendChild(groupLabel);

      for (const providerId of availableProviderIds) {
        const definition = providerRegistry[providerId];
        const state = allStates[providerId];
        const locked = lockedProviders.has(providerId);
        const card = document.createElement("button");
        card.type = "button";
        card.className = locked ? "provider-card provider-card-locked" : "provider-card";
        card.addEventListener("click", () => {
          if (locked) {
            options.onLockedProviderSelected(providerId);
            return;
          }
          if (state?.status === "awaiting_confirmation") return;
          options.onProviderSelected(providerId);
        });

        const isSyncing =
          state?.status === "extracting"
          || state?.status === "detecting_login"
          || state?.status === "waiting_for_login";
        card.disabled = isSyncing || state?.status === "awaiting_confirmation";
        const dotClass = isSyncing
          ? "syncing"
          : state?.status === "awaiting_confirmation"
            ? "attention"
          : state?.pendingBackendPush
            ? "error"
            : state?.status === "done"
            ? "done"
            : state?.status === "error"
              ? "error"
              : "idle";
        const lastSync = state?.lastSyncedAt && !state.pendingBackendPush
          ? formatRelativeTime(state.lastSyncedAt)
          : null;

        card.innerHTML = `
          <div class="provider-card-content">
            <div class="provider-icon"><img src="${getProviderIconUrl(providerId)}" alt="${escapeHtml(definition.name)}" /></div>
            <div class="provider-info">
              <div class="provider-name">${escapeHtml(definition.name)}</div>
              <div class="provider-desc">${escapeHtml(definition.description)}</div>
              ${lastSync ? `<div class="provider-last-sync">Synced ${lastSync}</div>` : ""}
            </div>
            ${locked ? `<div class="provider-lock-badge">Pro</div>` : `<div class="provider-status-dot ${dotClass}"></div>`}
            <div class="provider-arrow">&rsaquo;</div>
          </div>
        `;

        if (group.label === "Banks") {
          card.classList.add("tour-target");
        }

        const row = document.createElement("div");
        row.className = "provider-sync-card";
        row.dataset.syncProvider = providerId;
        const controls = document.createElement("div");
        controls.className = isSyncing ? "provider-card-row" : "provider-card-controls";
        if (group.label === "Banks") row.classList.add("tour-target");
        controls.appendChild(card);
        if (isSyncing) controls.appendChild(createStopButton(providerId));
        row.appendChild(controls);
        appendSyncProgress(row, state, providerId, options.onAccountReady);
        options.providerList.appendChild(row);
      }
    }

    const isSyncing = orderedProviderIds.some((providerId) => {
      const status = allStates[providerId]?.status;
      return (
        status === "extracting"
        || status === "detecting_login"
        || status === "waiting_for_login"
      );
    });
    const shouldLock =
      previewRewardsGuide || (!connectedRewards && !isSyncing);
    options.providerList.classList.toggle("tour-locked", shouldLock);
    options.tourTooltip.classList.toggle(
      "visible",
      previewRewardsGuide || !connectedRewards,
    );

    if (!firstSyncCompleted && !previewRewardsGuide && connectedRewards) {
      options.markFirstSyncCompleted();
      options.providerList.classList.remove("tour-locked");
    }
  };
}

function appendSyncProgress(
  container: HTMLElement,
  state: ProviderSyncState | undefined,
  providerId: ProviderId,
  onAccountReady: (providerId: ProviderId, attemptId: string) => Promise<boolean>,
) {
  if (!state) return;
  const active = state.status === "extracting" || state.status === "detecting_login" || state.status === "waiting_for_login";
  const detail = active
    ? state.progressMessage ?? (state.status === "waiting_for_login" ? "Waiting for sign-in and verification" : "Opening your account…")
    : state.status === "error" || state.pendingBackendPush || state.backendSyncStatus === "partial"
      ? state.backendSyncError ?? state.error ?? "Your latest data has not been fully saved. Try again."
      : state.status === "awaiting_confirmation"
        ? "Review the account owner below. Nothing is saved until you confirm."
        : null;
  if (!detail) return;
  const progress = document.createElement("div");
  progress.className = "rewards-sync-progress";
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-live", "polite");
  const message = document.createElement("p");
  message.className = "rewards-sync-title";
  message.textContent = state.accountPreparation
    ? `Sync for ${state.accountPreparation.memberDisplayName}`
    : detail;
  progress.appendChild(message);
  if (active) {
    const help = document.createElement("p");
    help.className = "rewards-sync-help";
    const providerName = providerRegistry[providerId].name;
    help.textContent = state.accountPreparation
      ? `Check the account in the ${providerName} tab. Switch accounts if needed.`
      : state.status === "waiting_for_login"
        ? `Finish sign-in and verification in the ${providerName} tab.`
        : `Keep the ${providerName} tab open until sync finishes.`;
    progress.appendChild(help);
  }
  if (active && state.accountPreparation) {
    const preparation = state.accountPreparation;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rewards-account-ready rewards-summary-primary";
    button.textContent = "Continue sync";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (!await onAccountReady(providerId, preparation.attemptId)) {
          message.textContent = "Could not continue this sync. Try again or stop and restart.";
        }
      } catch {
        message.textContent = "Could not continue this sync. Try again or stop and restart.";
      } finally {
        button.disabled = false;
      }
    });
    progress.appendChild(button);
  }
  container.appendChild(progress);
}
