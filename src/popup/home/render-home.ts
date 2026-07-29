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
import { hasConnectedRewards } from "./home-state";

export function buildHomeSnapshot(
  allStates: Record<ProviderId, ProviderSyncState>,
  rewardsSummaries: ExtensionRewardsSummary[],
  firstSyncCompleted: boolean,
  extensionProfile: ExtensionProfile | null,
  previewRewardsGuide = false,
) {
  return orderedProviderIds
    .map((providerId) => {
      const state = allStates[providerId];
      return [
        providerId,
        state?.status ?? "idle",
        state?.lastSyncedAt ?? "",
        state?.backendSyncStatus ?? "",
        state?.pendingBackendPush ? "pending" : "",
      ].join(":");
    })
    .join("|")
    + `|summaries:${JSON.stringify(rewardsSummaries)}`
    + `|tour:${firstSyncCompleted}|preview:${previewRewardsGuide}|plan:${extensionProfile?.accountLevel ?? "unknown"}|locked:${extensionProfile?.lockedProviders.join(",") ?? ""}`;
}

export function createHomeRenderer(options: {
  providerList: HTMLDivElement;
  tourTooltip: HTMLDivElement;
  getFirstSyncCompleted: () => boolean;
  getRewardsGuidePreview?: () => boolean;
  getExtensionProfile: () => ExtensionProfile | null;
  getRewardsSummaries: () => ExtensionRewardsSummary[];
  markFirstSyncCompleted: () => void;
  onProviderSelected: (providerId: ProviderId) => void;
  onLockedProviderSelected: (providerId: ProviderId) => void;
  onSummarySelected: (summary: ExtensionRewardsSummary) => void;
  onSummarySyncRequested: (providerId: ProviderId) => void;
}) {
  let lastHomeSnapshot = "";

  return (allStates: Record<ProviderId, ProviderSyncState>) => {
    const firstSyncCompleted = options.getFirstSyncCompleted();
    const previewRewardsGuide = options.getRewardsGuidePreview?.() ?? false;
    const extensionProfile = options.getExtensionProfile();
    const rewardsSummaries = options.getRewardsSummaries();
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
    );
    if (snapshot === lastHomeSnapshot) return;
    lastHomeSnapshot = snapshot;

    options.providerList.innerHTML = "";

    const summarizedProviders = new Set(
      rewardsSummaries.map((summary) => summary.provider),
    );
    if (rewardsSummaries.length > 0) {
      const groupLabel = document.createElement("div");
      groupLabel.className = "home-section-label rewards-summary-heading tour-target";
      groupLabel.textContent = "Your rewards";
      options.providerList.appendChild(groupLabel);

      for (const summary of rewardsSummaries) {
        const state = allStates[summary.provider];
        const definition = providerRegistry[summary.provider];
        const card = document.createElement("article");
        card.className = "rewards-summary-card";
        const isSyncing =
          state?.status === "extracting"
          || state?.status === "detecting_login"
          || state?.status === "waiting_for_login";
        const hasError =
          state?.pendingBackendPush
          || state?.status === "error"
          || state?.backendSyncStatus === "partial";
        const dotClass = isSyncing ? "syncing" : hasError ? "error" : "done";
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
            <div class="provider-status-dot ${dotClass}" aria-label="${isSyncing ? "Syncing" : hasError ? "Needs attention" : "Synced"}"></div>
          </div>
          <div class="rewards-summary-body">
            ${balance ? `<strong class="rewards-summary-balance" aria-label="Balance ${escapeHtml(balance)}">${escapeHtml(balance)}</strong>` : ""}
            ${summary.statusLevel ? `<span class="rewards-summary-status">${escapeHtml(summary.statusLevel)}</span>` : ""}
            ${meta ? `<div class="rewards-summary-meta">${escapeHtml(meta)}</div>` : ""}
            <div class="provider-last-sync">${isSyncing ? "Syncing now…" : `Synced ${lastSync ?? "recently"}`}</div>
          </div>
          <div class="rewards-summary-actions">
            <button class="rewards-summary-primary" type="button">View details <span aria-hidden="true">→</span></button>
            <button class="rewards-summary-secondary" type="button"${isSyncing ? " disabled" : ""}>${isSyncing ? "Syncing…" : hasError ? "Try again" : "Sync again"}</button>
          </div>
        `;

        card
          .querySelector<HTMLButtonElement>(".rewards-summary-primary")
          ?.addEventListener("click", () => options.onSummarySelected(summary));
        card
          .querySelector<HTMLButtonElement>(".rewards-summary-secondary")
          ?.addEventListener("click", () =>
            options.onSummarySyncRequested(summary.provider)
          );
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
          options.onProviderSelected(providerId);
        });

        const isSyncing =
          state?.status === "extracting"
          || state?.status === "detecting_login"
          || state?.status === "waiting_for_login";
        const dotClass = isSyncing
          ? "syncing"
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

        options.providerList.appendChild(card);
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
