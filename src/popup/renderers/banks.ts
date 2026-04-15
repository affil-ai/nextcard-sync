import type {
  AmexLoyaltyData,
  BiltLoyaltyData,
  CapitalOneLoyaltyData,
  ChaseURData,
  DiscoverLoyaltyData,
  CitiLoyaltyData,
  ProviderId,
  ProviderSyncState,
} from "../../lib/types";
import {
  escapeHtml,
  formatRelativeTime,
  renderValue,
  showConfirmDelete,
  STATUS_DOT_CLASS,
  STATUS_LABELS,
  STATUS_SUBTITLES,
} from "./shared";

export function createBankRenderers(
  requestSync: (providerId: ProviderId) => Promise<boolean>,
) {
  const chaseEls = {
    statusDot: document.getElementById("chaseStatusDot") as HTMLDivElement,
    statusText: document.getElementById("chaseStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("chaseStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("chaseLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("chaseSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("chaseCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("chaseClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("chaseErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("chaseLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("chaseDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("chaseRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("chaseRawData") as HTMLDivElement,
    cardsContainer: document.getElementById("chaseCardsContainer") as HTMLDivElement,
  };

  const amexEls = {
    statusDot: document.getElementById("amexStatusDot") as HTMLDivElement,
    statusText: document.getElementById("amexStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("amexStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("amexLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("amexSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("amexCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("amexClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("amexErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("amexLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("amexDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("amexRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("amexRawData") as HTMLDivElement,
    cardsContainer: document.getElementById("amexCardsContainer") as HTMLDivElement,
  };

  const capitaloneEls = {
    statusDot: document.getElementById("capitaloneStatusDot") as HTMLDivElement,
    statusText: document.getElementById("capitaloneStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("capitaloneStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("capitaloneLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("capitaloneSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("capitaloneCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("capitaloneClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("capitaloneErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("capitaloneLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("capitaloneDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("capitaloneRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("capitaloneRawData") as HTMLDivElement,
    cardsContainer: document.getElementById("capitaloneCardsContainer") as HTMLDivElement,
  };

  const biltEls = {
    statusDot: document.getElementById("biltStatusDot") as HTMLDivElement,
    statusText: document.getElementById("biltStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("biltStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("biltLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("biltSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("biltCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("biltClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("biltErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("biltLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("biltDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("biltRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("biltRawData") as HTMLDivElement,
    pointsBalance: document.getElementById("biltPointsBalance") as HTMLDivElement,
    eliteStatus: document.getElementById("biltEliteStatus") as HTMLDivElement,
    memberName: document.getElementById("biltMemberName") as HTMLDivElement,
    memberNameCard: document.getElementById("biltMemberNameCard") as HTMLDivElement,
    memberNumber: document.getElementById("biltMemberNumber") as HTMLDivElement,
    memberNumberCard: document.getElementById("biltMemberNumberCard") as HTMLDivElement,
    progressSection: document.getElementById("biltProgressSection") as HTMLDivElement,
    progressCards: document.getElementById("biltProgressCards") as HTMLDivElement,
  };

  function renderChaseBenefitHtml(benefit: ChaseURData["benefits"][number]) {
    const parts: string[] = [];
    if (benefit.amountUsed != null && benefit.totalAmount != null) {
      parts.push(`$${benefit.amountUsed.toFixed(2)} spent of $${benefit.totalAmount}`);
    }
    if (benefit.remaining != null) {
      parts.push(`$${benefit.remaining.toFixed(2)} remaining`);
    }
    if (benefit.period) {
      parts.push(escapeHtml(benefit.period));
    }
    if (benefit.activationStatus) {
      parts.push(escapeHtml(benefit.activationStatus));
    }

    let progressHtml = "";
    if (benefit.amountUsed != null && benefit.totalAmount != null && benefit.totalAmount > 0) {
      const pct = Math.min(
        100,
        Math.round((benefit.amountUsed / benefit.totalAmount) * 100),
      );
      progressHtml = `<div class="benefit-progress"><div class="benefit-progress-bar" style="width: ${pct}%"></div></div>`;
    }

    return `
      <li class="cert-item">
        <div class="cert-type">${escapeHtml(benefit.name)}</div>
        ${parts.length > 0 ? `<div class="cert-detail">${parts.join(" &middot; ")}</div>` : ""}
        ${progressHtml}
      </li>
    `;
  }

  function renderChaseCardHtml(card: ChaseURData) {
    const label = card.lastFourDigits
      ? `${escapeHtml(card.cardName ?? "Card")} (...${escapeHtml(card.lastFourDigits)})`
      : escapeHtml(card.cardName ?? "Card");
    const pointsHtml = card.availablePoints != null
      ? `<div class="data-grid"><div class="data-card"><div class="data-label">Points</div><div class="data-value">${card.availablePoints.toLocaleString()}</div></div>${card.pendingPoints != null ? `<div class="data-card"><div class="data-label">Pending</div><div class="data-value">${card.pendingPoints.toLocaleString()}</div></div>` : ""}</div>`
      : "";
    const benefitsHtml = card.benefits.length > 0
      ? `<ul class="certs-list" style="margin-top:8px">${card.benefits.map(renderChaseBenefitHtml).join("")}</ul>`
      : "";

    return `
      <div style="margin-bottom:16px">
        <h2 style="font-size:14px;margin:0 0 8px">${label}</h2>
        ${pointsHtml}
        ${benefitsHtml}
        ${!pointsHtml && !benefitsHtml ? '<div style="font-size:12px;color:#8c7a6e">No trackable benefits or points</div>' : ""}
      </div>
    `;
  }

  let lastChaseJson = "";
  function renderChase(state: ProviderSyncState<ChaseURData>) {
    const json = JSON.stringify(state);
    if (json === lastChaseJson) return;
    lastChaseJson = json;
    const { status, data, error, lastSyncedAt } = state;

    chaseEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    chaseEls.statusText.textContent = STATUS_LABELS[status];
    chaseEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    chaseEls.syncBtn.disabled = isBusy;
    chaseEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync Chase";
    chaseEls.cancelBtn.style.display = isBusy ? "block" : "none";
    chaseEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    chaseEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      chaseEls.lastSynced.textContent = `Last synced ${relative}`;
      chaseEls.lastSynced.style.display = "block";
    } else {
      chaseEls.lastSynced.style.display = "none";
    }

    chaseEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      chaseEls.dataSection.style.display = "none";
      chaseEls.rawToggle.style.display = "none";
      return;
    }

    chaseEls.dataSection.style.display = "block";
    const typedData = data as ChaseURData & { _allCards?: ChaseURData[] };
    const allCards =
      typedData._allCards && typedData._allCards.length > 0
        ? typedData._allCards
        : [data];
    chaseEls.cardsContainer.innerHTML = allCards.map(renderChaseCardHtml).join("");
    chaseEls.rawToggle.style.display = "block";
    chaseEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  chaseEls.syncBtn.addEventListener("click", () => {
    void requestSync("chase").then((started) => {
      if (started) {
        renderChase({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  chaseEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "chase" });
  });
  chaseEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Chase")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "chase" });
    }
  });
  chaseEls.rawToggle.addEventListener("click", () => {
    chaseEls.rawData.classList.toggle("visible");
    chaseEls.rawToggle.textContent = chaseEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  function renderAmexCardHtml(card: {
    cardName: string | null;
    availablePoints: number | null;
    pendingPoints?: number | null;
    benefits: AmexLoyaltyData["benefits"];
  }) {
    const label = escapeHtml(card.cardName ?? "Card");
    const pointsHtml = card.availablePoints != null
      ? `<div class="data-grid"><div class="data-card"><div class="data-label">Points</div><div class="data-value">${card.availablePoints.toLocaleString()}</div></div>${card.pendingPoints != null ? `<div class="data-card"><div class="data-label">Pending</div><div class="data-value">${card.pendingPoints.toLocaleString()}</div></div>` : ""}</div>`
      : "";
    const trackableBenefits = card.benefits.filter((benefit) => {
      return benefit.amountUsed != null || benefit.totalAmount != null;
    });
    const benefitsHtml = trackableBenefits.length > 0
      ? `<ul class="certs-list" style="margin-top:8px">${trackableBenefits
          .map((benefit) => {
            const parts: string[] = [];
            if (benefit.amountUsed != null && benefit.totalAmount != null) {
              parts.push(`$${benefit.amountUsed.toFixed(2)} spent of $${benefit.totalAmount}`);
            }
            if (benefit.remaining != null) {
              parts.push(`$${benefit.remaining.toFixed(2)} remaining`);
            }
            if (benefit.period) {
              parts.push(escapeHtml(benefit.period));
            }
            let progressHtml = "";
            if (
              benefit.amountUsed != null
              && benefit.totalAmount != null
              && benefit.totalAmount > 0
            ) {
              const pct = Math.min(
                100,
                Math.round((benefit.amountUsed / benefit.totalAmount) * 100),
              );
              progressHtml = `<div class="benefit-progress"><div class="benefit-progress-bar" style="width: ${pct}%"></div></div>`;
            }
            return `<li class="cert-item"><div class="cert-type">${escapeHtml(benefit.name)}</div>${parts.length > 0 ? `<div class="cert-detail">${parts.join(" &middot; ")}</div>` : ""}${progressHtml}</li>`;
          })
          .join("")}</ul>`
      : "";

    return `
      <div style="margin-bottom:16px">
        <h2 style="font-size:14px;margin:0 0 8px">${label}</h2>
        ${pointsHtml}
        ${benefitsHtml}
      </div>
    `;
  }

  let lastAmexJson = "";
  function renderAmex(state: ProviderSyncState<AmexLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastAmexJson) return;
    lastAmexJson = json;
    const { status, data, error, lastSyncedAt } = state;

    amexEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    amexEls.statusText.textContent = STATUS_LABELS[status];
    amexEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    amexEls.syncBtn.disabled = isBusy;
    amexEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync American Express";
    amexEls.cancelBtn.style.display = isBusy ? "block" : "none";
    amexEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    amexEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      amexEls.lastSynced.textContent = `Last synced ${relative}`;
      amexEls.lastSynced.style.display = "block";
    } else {
      amexEls.lastSynced.style.display = "none";
    }

    amexEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      amexEls.dataSection.style.display = "none";
      amexEls.rawToggle.style.display = "none";
      return;
    }

    amexEls.dataSection.style.display = "block";
    const typedData = data as AmexLoyaltyData & {
      _allCards?: Array<{
        cardName: string | null;
        availablePoints: number | null;
        pendingPoints?: number | null;
        benefits: AmexLoyaltyData["benefits"];
      }>;
    };
    const allCards =
      typedData._allCards && typedData._allCards.length > 0
        ? typedData._allCards
        : [data];
    amexEls.cardsContainer.innerHTML = allCards.map(renderAmexCardHtml).join("");
    amexEls.rawToggle.style.display = "block";
    amexEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  amexEls.syncBtn.addEventListener("click", () => {
    void requestSync("amex").then((started) => {
      if (started) {
        renderAmex({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  amexEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "amex" });
  });
  amexEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("American Express")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "amex" });
    }
  });
  amexEls.rawToggle.addEventListener("click", () => {
    amexEls.rawData.classList.toggle("visible");
    amexEls.rawToggle.textContent = amexEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  function formatCapitalOneRewardsValue(
    amount: number,
    rewardsLabel: string | null | undefined,
  ) {
    if (rewardsLabel?.toLowerCase().includes("cash")) {
      return `$${amount.toFixed(2)}`;
    }
    return amount.toLocaleString();
  }

  function renderCapitalOneCardHtml(card: {
    cardName: string | null;
    availablePoints: number | null;
    pendingPoints?: number | null;
    rewardsLabel?: string | null;
    benefits: CapitalOneLoyaltyData["benefits"];
  }) {
    const label = escapeHtml(card.cardName ?? "Card");
    const rewardsLabel = escapeHtml(card.rewardsLabel ?? "Rewards");
    const pointsHtml = card.availablePoints != null
      ? `<div class="data-grid"><div class="data-card"><div class="data-label">${rewardsLabel}</div><div class="data-value">${formatCapitalOneRewardsValue(card.availablePoints, card.rewardsLabel)}</div></div>${card.pendingPoints != null ? `<div class="data-card"><div class="data-label">Pending</div><div class="data-value">${card.pendingPoints.toLocaleString()}</div></div>` : ""}</div>`
      : "";
    const benefitsHtml = card.benefits.length > 0
      ? `<ul class="certs-list" style="margin-top:8px">${card.benefits
          .map((benefit) => {
            const parts: string[] = [];
            if (benefit.amountUsed != null && benefit.totalAmount != null) {
              parts.push(`$${benefit.amountUsed.toFixed(2)} spent of $${benefit.totalAmount}`);
            }
            if (benefit.remaining != null) {
              parts.push(`$${benefit.remaining.toFixed(2)} remaining`);
            }
            if (benefit.period) {
              parts.push(escapeHtml(benefit.period));
            }
            let progressHtml = "";
            if (
              benefit.amountUsed != null
              && benefit.totalAmount != null
              && benefit.totalAmount > 0
            ) {
              const pct = Math.min(
                100,
                Math.round((benefit.amountUsed / benefit.totalAmount) * 100),
              );
              progressHtml = `<div class="benefit-progress"><div class="benefit-progress-bar" style="width: ${pct}%"></div></div>`;
            }
            return `<li class="cert-item"><div class="cert-type">${escapeHtml(benefit.name)}</div>${parts.length > 0 ? `<div class="cert-detail">${parts.join(" &middot; ")}</div>` : ""}${progressHtml}</li>`;
          })
          .join("")}</ul>`
      : "";

    return `
      <div style="margin-bottom:16px">
        <h2 style="font-size:14px;margin:0 0 8px">${label}</h2>
        ${pointsHtml}
        ${benefitsHtml}
        ${!pointsHtml && !benefitsHtml ? '<div style="font-size:12px;color:#8c7a6e">No trackable benefits or rewards</div>' : ""}
      </div>
    `;
  }

  let lastCapitalOneJson = "";
  function renderCapitalOne(state: ProviderSyncState<CapitalOneLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastCapitalOneJson) return;
    lastCapitalOneJson = json;
    const { status, data, error, lastSyncedAt } = state;

    capitaloneEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    capitaloneEls.statusText.textContent = STATUS_LABELS[status];
    capitaloneEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    capitaloneEls.syncBtn.disabled = isBusy;
    capitaloneEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync Capital One";
    capitaloneEls.cancelBtn.style.display = isBusy ? "block" : "none";
    capitaloneEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    capitaloneEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      capitaloneEls.lastSynced.textContent = `Last synced ${relative}`;
      capitaloneEls.lastSynced.style.display = "block";
    } else {
      capitaloneEls.lastSynced.style.display = "none";
    }

    capitaloneEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      capitaloneEls.dataSection.style.display = "none";
      capitaloneEls.rawToggle.style.display = "none";
      return;
    }

    capitaloneEls.dataSection.style.display = "block";
    const typedData = data as CapitalOneLoyaltyData & {
      _allCards?: Array<{
        cardName: string | null;
        availablePoints: number | null;
        pendingPoints?: number | null;
        rewardsLabel?: string | null;
        benefits: CapitalOneLoyaltyData["benefits"];
      }>;
    };
    const allCards =
      typedData._allCards && typedData._allCards.length > 0
        ? typedData._allCards
        : [data];
    capitaloneEls.cardsContainer.innerHTML = allCards
      .map(renderCapitalOneCardHtml)
      .join("");
    capitaloneEls.rawToggle.style.display = "block";
    capitaloneEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  capitaloneEls.syncBtn.addEventListener("click", () => {
    void requestSync("capitalone").then((started) => {
      if (started) {
        renderCapitalOne({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  capitaloneEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "capitalone" });
  });
  capitaloneEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Capital One")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "capitalone" });
    }
  });
  capitaloneEls.rawToggle.addEventListener("click", () => {
    capitaloneEls.rawData.classList.toggle("visible");
    capitaloneEls.rawToggle.textContent = capitaloneEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  let lastBiltJson = "";
  function renderBilt(state: ProviderSyncState<BiltLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastBiltJson) return;
    lastBiltJson = json;
    const { status, data, error, lastSyncedAt } = state;

    biltEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    biltEls.statusText.textContent = STATUS_LABELS[status];
    biltEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    biltEls.syncBtn.disabled = isBusy;
    biltEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync Bilt Rewards";
    biltEls.cancelBtn.style.display = isBusy ? "block" : "none";
    biltEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    biltEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      biltEls.lastSynced.textContent = `Last synced ${relative}`;
      biltEls.lastSynced.style.display = "block";
    } else {
      biltEls.lastSynced.style.display = "none";
    }

    biltEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      biltEls.dataSection.style.display = "none";
      biltEls.rawToggle.style.display = "none";
      return;
    }

    biltEls.dataSection.style.display = "block";
    renderValue(biltEls.pointsBalance, data.pointsBalance?.toLocaleString() ?? null);
    renderValue(biltEls.eliteStatus, data.eliteStatus);

    if (data.memberName) {
      renderValue(biltEls.memberName, data.memberName);
      biltEls.memberNameCard.style.display = "";
    } else {
      biltEls.memberNameCard.style.display = "none";
    }
    if (data.memberNumber) {
      renderValue(biltEls.memberNumber, data.memberNumber);
      biltEls.memberNumberCard.style.display = "";
    } else {
      biltEls.memberNumberCard.style.display = "none";
    }

    const hasProgress = data.pointsTarget != null || data.spendTarget != null;
    biltEls.progressSection.style.display = hasProgress ? "block" : "none";
    if (hasProgress) {
      const trackers: Array<{
        label: string;
        current: number;
        target: number;
        display: string;
      }> = [];
      if (data.pointsProgress != null && data.pointsTarget != null) {
        trackers.push({
          label: "Points",
          current: data.pointsProgress,
          target: data.pointsTarget,
          display: `${data.pointsProgress.toLocaleString()} of ${data.pointsTarget.toLocaleString()}`,
        });
      }
      if (data.spendProgress && data.spendTarget) {
        const parseDollars = (value: string) => parseFloat(value.replace(/[$,]/g, ""));
        trackers.push({
          label: "Spend",
          current: parseDollars(data.spendProgress),
          target: parseDollars(data.spendTarget),
          display: `${data.spendProgress} of ${data.spendTarget}`,
        });
      }

      let headerText = "Status Progress";
      if (data.statusValidThrough) headerText += ` · through ${data.statusValidThrough}`;
      biltEls.progressSection.querySelector("h2")!.textContent = headerText;

      biltEls.progressCards.innerHTML = trackers
        .map((tracker) => {
          const pct = tracker.target > 0
            ? Math.min(100, (tracker.current / tracker.target) * 100)
            : 0;
          return `<div class="data-card"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="data-label" style="margin-bottom:0">${escapeHtml(tracker.label)}</span><span style="font-size:13px;font-weight:600;color:#342019">${escapeHtml(tracker.display)}</span></div><div class="benefit-progress"><div class="benefit-progress-bar" style="width:${pct}%"></div></div></div>`;
        })
        .join("");
    }

    biltEls.rawToggle.style.display = "block";
    biltEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  biltEls.syncBtn.addEventListener("click", () => {
    void requestSync("bilt").then((started) => {
      if (started) {
        renderBilt({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  biltEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "bilt" });
  });
  biltEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Bilt Rewards")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "bilt" });
    }
  });
  biltEls.rawToggle.addEventListener("click", () => {
    biltEls.rawData.classList.toggle("visible");
    biltEls.rawToggle.textContent = biltEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  // ── Discover ──

  const discoverEls = {
    statusDot: document.getElementById("discoverStatusDot") as HTMLDivElement,
    statusText: document.getElementById("discoverStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("discoverStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("discoverLastSynced") as HTMLDivElement,
    lastSyncedTime: document.getElementById("discoverLastSyncedTime") as HTMLSpanElement,
    syncBtn: document.getElementById("discoverSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("discoverCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("discoverClearBtn") as HTMLButtonElement,
    walletBtn: document.getElementById("discoverWalletBtn") as HTMLButtonElement,
    loginPrompt: document.getElementById("discoverLoginPrompt") as HTMLDivElement,
    errorMsg: document.getElementById("discoverError") as HTMLDivElement,
    dataSection: document.getElementById("discoverData") as HTMLDivElement,
    cashback: document.getElementById("discoverCashback") as HTMLSpanElement,
    cardEnding: document.getElementById("discoverCardEnding") as HTMLSpanElement,
    rawToggle: document.getElementById("discoverRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("discoverRawData") as HTMLPreElement,
  };

  let lastDiscoverJson = "";
  function renderDiscover(state: ProviderSyncState<DiscoverLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastDiscoverJson) return;
    lastDiscoverJson = json;
    const s = state.status;
    discoverEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[s] ?? "idle"}`;
    discoverEls.statusText.textContent = STATUS_LABELS[s] ?? "Ready to sync";
    discoverEls.statusSubtitle.textContent = STATUS_SUBTITLES[s] ?? "";
    const busy = s === "detecting_login" || s === "waiting_for_login" || s === "extracting";
    discoverEls.syncBtn.disabled = busy;
    discoverEls.syncBtn.textContent = s === "done" ? "Sync Again" : busy ? "Syncing..." : "Sync Discover";
    discoverEls.cancelBtn.style.display = busy ? "" : "none";
    discoverEls.loginPrompt.style.display = s === "waiting_for_login" ? "" : "none";
    discoverEls.errorMsg.style.display = s === "error" ? "" : "none";
    if (s === "error") discoverEls.errorMsg.textContent = state.error ?? "Unknown error";
    if (state.lastSyncedAt) {
      discoverEls.lastSynced.style.display = "";
      discoverEls.lastSyncedTime.textContent = formatRelativeTime(state.lastSyncedAt);
    } else {
      discoverEls.lastSynced.style.display = "none";
    }
    const d = state.data;
    if (d) {
      discoverEls.dataSection.style.display = "";
      discoverEls.cashback.textContent = d.cashbackBalance != null ? `$${d.cashbackBalance.toFixed(2)}` : "--";
      discoverEls.cardEnding.textContent = d.lastFourDigits ? `Card ending in ${d.lastFourDigits}` : "--";
      discoverEls.rawToggle.style.display = "";
      discoverEls.rawData.textContent = JSON.stringify(d, null, 2);
      discoverEls.clearBtn.style.display = "";
    } else {
      discoverEls.dataSection.style.display = "none";
      discoverEls.rawToggle.style.display = "none";
      discoverEls.clearBtn.style.display = "none";
    }
  }

  discoverEls.syncBtn.addEventListener("click", () => requestSync("discover"));
  discoverEls.cancelBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "discover" }));
  discoverEls.walletBtn?.addEventListener("click", () => { /* openWallet */ });
  discoverEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Discover")) chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "discover" });
  });
  discoverEls.rawToggle.addEventListener("click", () => {
    discoverEls.rawData.classList.toggle("visible");
    discoverEls.rawToggle.textContent = discoverEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  // ── Citi ──

  const citiEls = {
    statusDot: document.getElementById("citiStatusDot") as HTMLDivElement,
    statusText: document.getElementById("citiStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("citiStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("citiLastSynced") as HTMLDivElement,
    lastSyncedTime: document.getElementById("citiLastSyncedTime") as HTMLSpanElement,
    syncBtn: document.getElementById("citiSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("citiCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("citiClearBtn") as HTMLButtonElement,
    walletBtn: document.getElementById("citiWalletBtn") as HTMLButtonElement,
    loginPrompt: document.getElementById("citiLoginPrompt") as HTMLDivElement,
    errorMsg: document.getElementById("citiError") as HTMLDivElement,
    dataSection: document.getElementById("citiData") as HTMLDivElement,
    cardsContainer: document.getElementById("citiCardsContainer") as HTMLDivElement,
    rawToggle: document.getElementById("citiRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("citiRawData") as HTMLPreElement,
  };

  let lastCitiJson = "";
  function renderCiti(state: ProviderSyncState<CitiLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastCitiJson) return;
    lastCitiJson = json;
    const s = state.status;
    citiEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[s] ?? "idle"}`;
    citiEls.statusText.textContent = STATUS_LABELS[s] ?? "Ready to sync";
    citiEls.statusSubtitle.textContent = STATUS_SUBTITLES[s] ?? "";
    const busy = s === "detecting_login" || s === "waiting_for_login" || s === "extracting";
    citiEls.syncBtn.disabled = busy;
    citiEls.syncBtn.textContent = s === "done" ? "Sync Again" : busy ? "Syncing..." : "Sync Citi";
    citiEls.cancelBtn.style.display = busy ? "" : "none";
    citiEls.loginPrompt.style.display = s === "waiting_for_login" ? "" : "none";
    citiEls.errorMsg.style.display = s === "error" ? "" : "none";
    if (s === "error") citiEls.errorMsg.textContent = state.error ?? "Unknown error";
    if (state.lastSyncedAt) {
      citiEls.lastSynced.style.display = "";
      citiEls.lastSyncedTime.textContent = formatRelativeTime(state.lastSyncedAt);
    } else {
      citiEls.lastSynced.style.display = "none";
    }
    const d = state.data;
    if (d && d.cards.length > 0) {
      citiEls.dataSection.style.display = "";
      citiEls.cardsContainer.innerHTML = d.cards.map((card) => {
        const name = escapeHtml(card.cardName ?? "Unknown Card");
        const last4 = card.lastFourDigits ? ` (${escapeHtml(card.lastFourDigits)})` : "";
        const balance = card.rewardsBalance != null ? card.rewardsBalance.toLocaleString() : "--";
        const label = escapeHtml(card.rewardsLabel ?? "Rewards");
        return `
          <div style="margin-bottom:16px">
            <h2 style="font-size:14px;margin:0 0 8px">${name}${last4}</h2>
            <div class="data-grid">
              <div class="data-card"><div class="data-label">${label}</div><div class="data-value">${balance}</div></div>
            </div>
          </div>
        `;
      }).join("");
      citiEls.rawToggle.style.display = "";
      citiEls.rawData.textContent = JSON.stringify(d, null, 2);
      citiEls.clearBtn.style.display = "";
    } else {
      citiEls.dataSection.style.display = "none";
      citiEls.rawToggle.style.display = "none";
      citiEls.clearBtn.style.display = "none";
    }
  }

  citiEls.syncBtn.addEventListener("click", () => requestSync("citi"));
  citiEls.cancelBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "citi" }));
  citiEls.walletBtn?.addEventListener("click", () => { /* openWallet */ });
  citiEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Citi")) chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "citi" });
  });
  citiEls.rawToggle.addEventListener("click", () => {
    citiEls.rawData.classList.toggle("visible");
    citiEls.rawToggle.textContent = citiEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  return {
    renderChase,
    renderAmex,
    renderCapitalOne,
    renderBilt,
    renderDiscover,
    renderCiti,
  };
}
