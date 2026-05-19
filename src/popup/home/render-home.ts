import type { ExtensionProfile, ProviderId, ProviderSyncState } from "../../lib/types";
import { orderedProviderIds, providerGroups } from "../../providers/provider-groups";
import {
  getProviderIconUrl,
  providerRegistry,
} from "../../providers/provider-registry";
import { escapeHtml, formatRelativeTime } from "../renderers/shared";

export function buildHomeSnapshot(
  allStates: Record<ProviderId, ProviderSyncState>,
  firstSyncCompleted: boolean,
  extensionProfile: ExtensionProfile | null,
) {
  return orderedProviderIds
    .map((providerId) => {
      const state = allStates[providerId];
      return `${providerId}:${state?.status ?? "idle"}:${state?.lastSyncedAt ?? ""}`;
    })
    .join("|")
    + `|tour:${firstSyncCompleted}|plan:${extensionProfile?.accountLevel ?? "unknown"}|locked:${extensionProfile?.lockedProviders.join(",") ?? ""}`;
}

export function populateOnboardingProviders(container: HTMLDivElement) {
  container.innerHTML = "";

  // Duplicate the provider set so the marquee loops without a seam.
  for (let copy = 0; copy < 2; copy += 1) {
    for (const providerId of orderedProviderIds) {
      const img = document.createElement("img");
      img.src = getProviderIconUrl(providerId);
      img.alt = providerRegistry[providerId].name;
      container.appendChild(img);
    }
  }
}

export function createHomeRenderer(options: {
  providerList: HTMLDivElement;
  tourTooltip: HTMLDivElement;
  getFirstSyncCompleted: () => boolean;
  getExtensionProfile: () => ExtensionProfile | null;
  markFirstSyncCompleted: () => void;
  onProviderSelected: (providerId: ProviderId) => void;
  onLockedProviderSelected: (providerId: ProviderId) => void;
}) {
  let lastHomeSnapshot = "";

  return (allStates: Record<ProviderId, ProviderSyncState>) => {
    const firstSyncCompleted = options.getFirstSyncCompleted();
    const extensionProfile = options.getExtensionProfile();
    const lockedProviders = new Set(extensionProfile?.lockedProviders ?? []);
    const snapshot = buildHomeSnapshot(allStates, firstSyncCompleted, extensionProfile);
    if (snapshot === lastHomeSnapshot) return;
    lastHomeSnapshot = snapshot;

    options.providerList.innerHTML = "";

    for (const group of providerGroups) {
      const groupLabel = document.createElement("div");
      groupLabel.className = "home-section-label";
      if (group.label === "Banks") {
        groupLabel.classList.add("tour-target");
      }
      groupLabel.style.marginTop = "16px";
      groupLabel.textContent = group.label;
      options.providerList.appendChild(groupLabel);

      for (const providerId of group.ids) {
        const definition = providerRegistry[providerId];
        const state = allStates[providerId];
        const locked = lockedProviders.has(providerId);
        const card = document.createElement("div");
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
          : state?.status === "done"
            ? "done"
            : state?.status === "error"
              ? "error"
              : "idle";
        const lastSync = state?.lastSyncedAt
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
    const shouldLock = !firstSyncCompleted && !isSyncing;
    options.providerList.classList.toggle("tour-locked", shouldLock);
    options.tourTooltip.classList.toggle("visible", shouldLock);

    if (!firstSyncCompleted) {
      const anyDone = orderedProviderIds.some(
        (providerId) => allStates[providerId]?.status === "done",
      );
      if (anyDone) {
        options.markFirstSyncCompleted();
        options.providerList.classList.remove("tour-locked");
      }
    }
  };
}
