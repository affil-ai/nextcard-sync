import type {
  AALoyaltyData,
  AtmosLoyaltyData,
  DeltaLoyaltyData,
  FrontierLoyaltyData,
  ProviderId,
  ProviderSyncState,
  SouthwestLoyaltyData,
  UnitedLoyaltyData,
} from "../../lib/types";
import {
  AirlineEls,
  escapeHtml,
  formatRelativeTime,
  formatTerms,
  getAirlineEls,
  renderAirline,
  renderIssueReportHtml,
  renderValue,
  showConfirmDelete,
  STATUS_DOT_CLASS,
  STATUS_LABELS,
  STATUS_SUBTITLES,
  wireAirlineEvents,
} from "./shared";

export function createAirlineRenderers(
  requestSync: (providerId: ProviderId) => Promise<boolean>,
) {
  const openDiscountDetails = new Set<number>();

  const atmosEls = {
    statusDot: document.getElementById("atmosStatusDot") as HTMLDivElement,
    statusText: document.getElementById("atmosStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("atmosStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("atmosLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("atmosSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("atmosCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("atmosClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("atmosErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("atmosLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("atmosDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("atmosRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("atmosRawData") as HTMLDivElement,
    availablePoints: document.getElementById("atmosAvailablePoints") as HTMLDivElement,
    statusPoints: document.getElementById("atmosStatusPoints") as HTMLDivElement,
    statusLevel: document.getElementById("atmosStatusLevel") as HTMLDivElement,
    memberInfo: document.getElementById("atmosMemberInfo") as HTMLDivElement,
    rewardsContainer: document.getElementById("atmosRewardsContainer") as HTMLDivElement,
    rewardsList: document.getElementById("atmosRewardsList") as HTMLUListElement,
    discountsContainer: document.getElementById("atmosDiscountsContainer") as HTMLDivElement,
    discountsList: document.getElementById("atmosDiscountsList") as HTMLUListElement,
  };

  let lastAtmosJson = "";
  function renderAtmos(state: ProviderSyncState<AtmosLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastAtmosJson) return;
    lastAtmosJson = json;
    const { status, data, error, lastSyncedAt, progressMessage } = state;

    atmosEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    atmosEls.statusText.textContent = STATUS_LABELS[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    atmosEls.statusSubtitle.textContent =
      isBusy && progressMessage ? progressMessage : STATUS_SUBTITLES[status];
    atmosEls.syncBtn.disabled = isBusy;
    atmosEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync Alaska Atmos";
    atmosEls.cancelBtn.style.display = isBusy ? "block" : "none";
    atmosEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    atmosEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      atmosEls.lastSynced.textContent = `Last synced ${relative}`;
      atmosEls.lastSynced.style.display = "block";
    } else {
      atmosEls.lastSynced.style.display = "none";
    }

    atmosEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>${renderIssueReportHtml("Alaska Atmos", "atmos", status, error)}`
      : renderIssueReportHtml("Alaska Atmos", "atmos", status, null);

    if (!data) {
      atmosEls.dataSection.style.display = "none";
      atmosEls.rawToggle.style.display = "none";
      return;
    }

    atmosEls.dataSection.style.display = "block";
    renderValue(atmosEls.availablePoints, data.availablePoints?.toLocaleString() ?? null);
    renderValue(atmosEls.statusPoints, data.statusPoints?.toLocaleString() ?? null);
    renderValue(atmosEls.statusLevel, data.statusLevel);

    const memberParts = [data.memberName, data.memberNumber].filter(Boolean);
    renderValue(
      atmosEls.memberInfo,
      memberParts.length > 0 ? memberParts.join(" - ") : null,
    );

    if (data.rewards && data.rewards.length > 0) {
      atmosEls.rewardsContainer.style.display = "block";
      atmosEls.rewardsList.innerHTML = data.rewards
        .map((reward) => {
          const parts: string[] = [];
          if (reward.associatedCard) parts.push(escapeHtml(reward.associatedCard));
          if (reward.useBy) parts.push(`Expires ${escapeHtml(reward.useBy)}`);
          return `
            <li class="cert-item">
              <div class="cert-type">${escapeHtml(reward.title)}</div>
              ${parts.length > 0 ? `<div class="cert-detail">${parts.join(" &middot; ")}</div>` : ""}
            </li>
          `;
        })
        .join("");
    } else {
      atmosEls.rewardsContainer.style.display = "none";
    }

    if (data.discounts && data.discounts.length > 0) {
      atmosEls.discountsContainer.style.display = "block";
      atmosEls.discountsList.innerHTML = data.discounts
        .map((discount, index) => {
          const meta: string[] = [];
          if (discount.code) meta.push(`Code: ${escapeHtml(discount.code)}`);
          if (discount.expiration) meta.push(`Expires ${escapeHtml(discount.expiration)}`);
          const hasDetails = !!discount.details;
          const isOpen = openDiscountDetails.has(index);
          return `
            <li class="cert-item">
              <div class="cert-type">${escapeHtml(discount.name)}</div>
              ${meta.length > 0 ? `<div class="cert-detail">${meta.join(" &middot; ")}</div>` : ""}
              ${hasDetails ? `<button class="details-toggle" data-idx="${index}">${isOpen ? "Hide terms &amp; conditions" : "View terms &amp; conditions"}</button>` : ""}
              ${hasDetails ? `<div class="details-content${isOpen ? " open" : ""}">${formatTerms(discount.details!)}</div>` : ""}
            </li>
          `;
        })
        .join("");

      for (const button of atmosEls.discountsList.querySelectorAll(".details-toggle")) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const idx = parseInt(button.getAttribute("data-idx") ?? "", 10);
          if (Number.isNaN(idx)) return;
          const content = button.nextElementSibling;
          if (!content) return;
          const isOpen = content.classList.toggle("open");
          if (isOpen) {
            openDiscountDetails.add(idx);
          } else {
            openDiscountDetails.delete(idx);
          }
          button.innerHTML = isOpen
            ? "Hide terms &amp; conditions"
            : "View terms &amp; conditions";
        });
      }
    } else {
      atmosEls.discountsContainer.style.display = "none";
    }

    atmosEls.rawToggle.style.display = "block";
    atmosEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  atmosEls.syncBtn.addEventListener("click", () => {
    void requestSync("atmos").then((started) => {
      if (started) {
        renderAtmos({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
          progressMessage: null,
        });
      }
    });
  });
  atmosEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "atmos" });
  });
  atmosEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Alaska Atmos")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "atmos" });
    }
  });
  atmosEls.rawToggle.addEventListener("click", () => {
    atmosEls.rawData.classList.toggle("visible");
    atmosEls.rawToggle.textContent = atmosEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  const aaEls = getAirlineEls("aa", ["loyaltyPoints", "lpToNextTier", "millionMiler"]);
  const lastAAJson = { value: "" };
  function renderAA(state: ProviderSyncState<AALoyaltyData>) {
    renderAirline(aaEls, state, "aa", "AAdvantage", lastAAJson, (data, els) => {
      renderValue(
        els.extraFields.loyaltyPoints,
        typeof data.loyaltyPoints === "number"
          ? data.loyaltyPoints.toLocaleString()
          : null,
      );
      renderValue(
        els.extraFields.lpToNextTier,
        typeof data.loyaltyPointsToNextTier === "string"
          ? data.loyaltyPointsToNextTier
          : null,
      );
      renderValue(
        els.extraFields.millionMiler,
        typeof data.millionMilerMiles === "number"
          ? data.millionMilerMiles.toLocaleString()
          : null,
      );
    });
  }
  wireAirlineEvents(aaEls, "aa", "AAdvantage", requestSync, () => {
    renderAA({
      status: "detecting_login",
      data: null,
      error: null,
      lastSyncedAt: null,
      progressMessage: null,
    });
  });

  const deltaEls = getAirlineEls("delta", [
    "mqds",
    "mqdsToNext",
    "lifetimeMiles",
    "deltaAmexCard",
    "memberSince",
  ]);
  const lastDeltaJson = { value: "" };
  function renderDelta(state: ProviderSyncState<DeltaLoyaltyData>) {
    renderAirline(deltaEls, state, "delta", "Delta SkyMiles", lastDeltaJson, (data, els) => {
      renderValue(
        els.extraFields.mqds,
        typeof data.mqds === "number" ? `$${data.mqds.toLocaleString()}` : null,
      );
      renderValue(
        els.extraFields.mqdsToNext,
        typeof data.mqdsToNextTier === "string" ? data.mqdsToNextTier : null,
      );
      renderValue(
        els.extraFields.lifetimeMiles,
        typeof data.lifetimeMiles === "number"
          ? data.lifetimeMiles.toLocaleString()
          : null,
      );
      renderValue(
        els.extraFields.deltaAmexCard,
        typeof data.deltaAmexCard === "string" ? data.deltaAmexCard : null,
      );
      renderValue(
        els.extraFields.memberSince,
        typeof data.memberSince === "string" ? data.memberSince : null,
      );
    });
  }
  wireAirlineEvents(deltaEls, "delta", "Delta SkyMiles", requestSync, () => {
    renderDelta({
      status: "detecting_login",
      data: null,
      error: null,
      lastSyncedAt: null,
      progressMessage: null,
    });
  });

  const unitedEls = getAirlineEls("united", [
    "pqps",
    "pqfs",
    "lifetimeMiles",
    "travelBankBalance",
  ]);
  const lastUnitedJson = { value: "" };
  function renderUnited(state: ProviderSyncState<UnitedLoyaltyData>) {
    renderAirline(unitedEls, state, "united", "United MileagePlus", lastUnitedJson, (data, els) => {
      renderValue(
        els.extraFields.pqps,
        typeof data.pqps === "number" ? data.pqps.toLocaleString() : null,
      );
      renderValue(
        els.extraFields.pqfs,
        typeof data.pqfs === "number" ? data.pqfs.toLocaleString() : null,
      );
      renderValue(
        els.extraFields.lifetimeMiles,
        typeof data.lifetimeMiles === "number"
          ? data.lifetimeMiles.toLocaleString()
          : null,
      );
      renderValue(
        els.extraFields.travelBankBalance,
        typeof data.travelBankBalance === "string" ? data.travelBankBalance : null,
      );
    });
  }
  wireAirlineEvents(unitedEls, "united", "United MileagePlus", requestSync, () => {
    renderUnited({
      status: "detecting_login",
      data: null,
      error: null,
      lastSyncedAt: null,
      progressMessage: null,
    });
  });

  const southwestEls = getAirlineEls("southwest", [
    "availableCredits",
    "memberSince",
    "aListProgress",
    "companionPassProgress",
  ]);
  const lastSouthwestJson = { value: "" };
  const formatProgress = (
    current: number | null,
    target: number | null,
    unit: string,
  ) => {
    if (current == null && target == null) return null;
    const currentLabel = current != null ? current.toLocaleString() : "--";
    const targetLabel = target != null ? target.toLocaleString() : "--";
    return `${currentLabel} / ${targetLabel} ${unit}`;
  };
  function renderSouthwest(state: ProviderSyncState<SouthwestLoyaltyData>) {
    renderAirline(
      southwestEls,
      state,
      "southwest",
      "Southwest Rapid Rewards",
      lastSouthwestJson,
      (data, els) => {
        renderValue(
          els.extraFields.availableCredits,
          typeof data.availableCreditsDollars === "string"
            ? data.availableCreditsDollars
            : null,
        );
        renderValue(
          els.extraFields.memberSince,
          typeof data.memberSince === "string" ? data.memberSince : null,
        );

        const aListProgress = [
          formatProgress(data.aListFlights ?? null, data.aListFlightsTarget ?? null, "flights"),
          formatProgress(data.aListPoints ?? null, data.aListPointsTarget ?? null, "points"),
        ]
          .filter(Boolean)
          .join(" or ");
        renderValue(els.extraFields.aListProgress, aListProgress || null);

        const companionPassProgress = [
          formatProgress(
            data.companionFlights ?? null,
            data.companionFlightsTarget ?? null,
            "flights",
          ),
          formatProgress(
            data.companionPoints ?? null,
            data.companionPointsTarget ?? null,
            "points",
          ),
        ]
          .filter(Boolean)
          .join(" or ");
        renderValue(els.extraFields.companionPassProgress, companionPassProgress || null);
      },
    );
  }
  wireAirlineEvents(
    southwestEls,
    "southwest",
    "Southwest Rapid Rewards",
    requestSync,
    () => {
      renderSouthwest({
        status: "detecting_login",
        data: null,
        error: null,
        lastSyncedAt: null,
        progressMessage: null,
      });
    },
  );

  const frontierEls = getAirlineEls("frontier", [
    "eliteStatusPoints",
    "statusExpiration",
    "nextEliteStatus",
  ]);
  const lastFrontierJson = { value: "" };
  function renderFrontier(state: ProviderSyncState<FrontierLoyaltyData>) {
    renderAirline(frontierEls, state, "frontier", "Frontier Miles", lastFrontierJson, (data, els) => {
      renderValue(
        els.extraFields.eliteStatusPoints,
        typeof data.eliteStatusPoints === "number"
          ? data.eliteStatusPoints.toLocaleString()
          : null,
      );
      renderValue(
        els.extraFields.statusExpiration,
        typeof data.statusExpiration === "string" ? data.statusExpiration : null,
      );
      const nextTierLabel = typeof data.nextEliteStatusTarget === "number"
        ? `${typeof data.nextEliteStatus === "string" ? data.nextEliteStatus : "Next Tier"} (${data.nextEliteStatusTarget.toLocaleString()})`
        : typeof data.nextEliteStatus === "string"
          ? data.nextEliteStatus
          : null;
      renderValue(els.extraFields.nextEliteStatus, nextTierLabel);
    });
  }
  wireAirlineEvents(frontierEls, "frontier", "Frontier Miles", requestSync, () => {
    renderFrontier({
      status: "detecting_login",
      data: null,
      error: null,
      lastSyncedAt: null,
      progressMessage: null,
    });
  });

  return {
    renderAtmos,
    renderAA,
    renderDelta,
    renderUnited,
    renderSouthwest,
    renderFrontier,
  };
}
