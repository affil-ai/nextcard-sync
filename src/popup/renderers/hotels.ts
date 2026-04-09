import type {
  HiltonLoyaltyData,
  HyattLoyaltyData,
  IHGLoyaltyData,
  MarriottLoyaltyData,
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

export function createHotelRenderers(
  requestSync: (providerId: ProviderId) => Promise<boolean>,
) {
  const marriottEls = {
    statusDot: document.getElementById("marriottStatusDot") as HTMLDivElement,
    statusText: document.getElementById("marriottStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("marriottStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("marriottLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("marriottSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("marriottCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("marriottClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("marriottErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("marriottLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("marriottDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("marriottRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("marriottRawData") as HTMLDivElement,
    points: document.getElementById("marriottPoints") as HTMLDivElement,
    eliteStatus: document.getElementById("marriottEliteStatus") as HTMLDivElement,
    nightsCurrent: document.getElementById("marriottNightsCurrent") as HTMLDivElement,
    nightsLifetime: document.getElementById("marriottNightsLifetime") as HTMLDivElement,
    nightsStayed: document.getElementById("marriottNightsStayed") as HTMLDivElement,
    bonusNights: document.getElementById("marriottBonusNights") as HTMLDivElement,
    qualifiedSpend: document.getElementById("marriottQualifiedSpend") as HTMLDivElement,
    nextTier: document.getElementById("marriottNextTier") as HTMLDivElement,
    memberInfo: document.getElementById("marriottMemberInfo") as HTMLDivElement,
    lifetimeContainer: document.getElementById("marriottLifetimeContainer") as HTMLDivElement,
    yearsSilver: document.getElementById("marriottYearsSilver") as HTMLDivElement,
    yearsGold: document.getElementById("marriottYearsGold") as HTMLDivElement,
    yearsPlatinum: document.getElementById("marriottYearsPlatinum") as HTMLDivElement,
    certsContainer: document.getElementById("marriottCertsContainer") as HTMLDivElement,
    certsList: document.getElementById("marriottCertsList") as HTMLUListElement,
  };

  const ihgEls = {
    statusDot: document.getElementById("ihgStatusDot") as HTMLDivElement,
    statusText: document.getElementById("ihgStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("ihgStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("ihgLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("ihgSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("ihgCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("ihgClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("ihgErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("ihgLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("ihgDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("ihgRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("ihgRawData") as HTMLDivElement,
    pointsBalance: document.getElementById("ihgPointsBalance") as HTMLDivElement,
    eliteStatus: document.getElementById("ihgEliteStatus") as HTMLDivElement,
    memberName: document.getElementById("ihgMemberName") as HTMLDivElement,
    memberNameCard: document.getElementById("ihgMemberNameCard") as HTMLDivElement,
    memberNumber: document.getElementById("ihgMemberNumber") as HTMLDivElement,
    memberNumberCard: document.getElementById("ihgMemberNumberCard") as HTMLDivElement,
    nextTier: document.getElementById("ihgNextTier") as HTMLDivElement,
    qualifyingNights: document.getElementById("ihgQualifyingNights") as HTMLDivElement,
    milestoneNights: document.getElementById("ihgMilestoneNights") as HTMLDivElement,
    milestoneRewardAt: document.getElementById("ihgMilestoneRewardAt") as HTMLDivElement,
    progressSection: document.getElementById("ihgProgressSection") as HTMLDivElement,
    progressHeading: document.getElementById("ihgProgressHeading") as HTMLHeadingElement,
    progressCards: document.getElementById("ihgProgressCards") as HTMLDivElement,
  };

  const hyattEls = {
    statusDot: document.getElementById("hyattStatusDot") as HTMLDivElement,
    statusText: document.getElementById("hyattStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("hyattStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("hyattLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("hyattSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("hyattCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("hyattClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("hyattErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("hyattLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("hyattDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("hyattRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("hyattRawData") as HTMLDivElement,
    pointsBalance: document.getElementById("hyattPointsBalance") as HTMLDivElement,
    eliteStatus: document.getElementById("hyattEliteStatus") as HTMLDivElement,
    qualifyingNights: document.getElementById("hyattQualifyingNights") as HTMLDivElement,
    qualifyingNightsCard: document.getElementById("hyattQualifyingNightsCard") as HTMLDivElement,
    memberSince: document.getElementById("hyattMemberSince") as HTMLDivElement,
    memberName: document.getElementById("hyattMemberName") as HTMLDivElement,
    memberNameCard: document.getElementById("hyattMemberNameCard") as HTMLDivElement,
    memberNumber: document.getElementById("hyattMemberNumber") as HTMLDivElement,
    memberNumberCard: document.getElementById("hyattMemberNumberCard") as HTMLDivElement,
    milestoneChoicesSection: document.getElementById("hyattMilestoneChoicesSection") as HTMLDivElement,
    milestoneChoices: document.getElementById("hyattMilestoneChoices") as HTMLDivElement,
    awardsSection: document.getElementById("hyattAwardsSection") as HTMLDivElement,
    awards: document.getElementById("hyattAwards") as HTMLDivElement,
  };

  const hiltonEls = {
    statusDot: document.getElementById("hiltonStatusDot") as HTMLDivElement,
    statusText: document.getElementById("hiltonStatusText") as HTMLSpanElement,
    statusSubtitle: document.getElementById("hiltonStatusSubtitle") as HTMLDivElement,
    lastSynced: document.getElementById("hiltonLastSynced") as HTMLDivElement,
    syncBtn: document.getElementById("hiltonSyncBtn") as HTMLButtonElement,
    cancelBtn: document.getElementById("hiltonCancelBtn") as HTMLButtonElement,
    clearBtn: document.getElementById("hiltonClearBtn") as HTMLButtonElement,
    errorContainer: document.getElementById("hiltonErrorContainer") as HTMLDivElement,
    loginPrompt: document.getElementById("hiltonLoginPrompt") as HTMLDivElement,
    dataSection: document.getElementById("hiltonDataSection") as HTMLDivElement,
    rawToggle: document.getElementById("hiltonRawToggle") as HTMLButtonElement,
    rawData: document.getElementById("hiltonRawData") as HTMLDivElement,
    pointsBalance: document.getElementById("hiltonPointsBalance") as HTMLDivElement,
    eliteStatus: document.getElementById("hiltonEliteStatus") as HTMLDivElement,
    memberName: document.getElementById("hiltonMemberName") as HTMLDivElement,
    memberNameCard: document.getElementById("hiltonMemberNameCard") as HTMLDivElement,
    memberNumber: document.getElementById("hiltonMemberNumber") as HTMLDivElement,
    memberNumberCard: document.getElementById("hiltonMemberNumberCard") as HTMLDivElement,
    progressSection: document.getElementById("hiltonProgressSection") as HTMLDivElement,
    progressHeading: document.getElementById("hiltonProgressHeading") as HTMLHeadingElement,
    progressCards: document.getElementById("hiltonProgressCards") as HTMLDivElement,
  };

  let lastMarriottJson = "";
  function renderMarriott(state: ProviderSyncState<MarriottLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastMarriottJson) return;
    lastMarriottJson = json;
    const { status, data, error, lastSyncedAt } = state;

    marriottEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    marriottEls.statusText.textContent = STATUS_LABELS[status];
    marriottEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    marriottEls.syncBtn.disabled = isBusy;
    marriottEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync Marriott Bonvoy";
    marriottEls.cancelBtn.style.display = isBusy ? "block" : "none";
    marriottEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    marriottEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      marriottEls.lastSynced.textContent = `Last synced ${relative}`;
      marriottEls.lastSynced.style.display = "block";
    } else {
      marriottEls.lastSynced.style.display = "none";
    }

    marriottEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      marriottEls.dataSection.style.display = "none";
      marriottEls.rawToggle.style.display = "none";
      return;
    }

    marriottEls.dataSection.style.display = "block";
    renderValue(marriottEls.points, data.pointsBalance?.toLocaleString() ?? null);
    renderValue(marriottEls.eliteStatus, data.eliteStatus);
    renderValue(
      marriottEls.nightsCurrent,
      data.eliteNightsCurrentYear?.toString() ?? null,
    );
    renderValue(
      marriottEls.nightsLifetime,
      data.eliteNightsLifetime?.toString() ?? null,
    );
    renderValue(marriottEls.nightsStayed, data.nightsStayed?.toString() ?? null);
    renderValue(marriottEls.bonusNights, data.bonusNights?.toString() ?? null);
    renderValue(marriottEls.qualifiedSpend, data.totalQualifiedSpend);
    renderValue(marriottEls.nextTier, data.nextTierTarget);

    const memberParts = [data.memberName, data.memberNumber].filter(Boolean);
    renderValue(
      marriottEls.memberInfo,
      memberParts.length > 0 ? memberParts.join(" - ") : null,
    );

    const hasLifetime =
      data.yearsAsSilverPlus != null
      || data.yearsAsGoldPlus != null
      || data.yearsAsPlatinum != null;
    marriottEls.lifetimeContainer.style.display = hasLifetime ? "block" : "none";
    if (hasLifetime) {
      renderValue(marriottEls.yearsSilver, data.yearsAsSilverPlus?.toString() ?? null);
      renderValue(marriottEls.yearsGold, data.yearsAsGoldPlus?.toString() ?? null);
      renderValue(marriottEls.yearsPlatinum, data.yearsAsPlatinum?.toString() ?? null);
    }

    if (data.certificates.length > 0) {
      marriottEls.certsContainer.style.display = "block";
      marriottEls.certsList.innerHTML = data.certificates
        .map((certificate) => `
          <li class="cert-item">
            <div class="cert-type">${escapeHtml(certificate.type)}</div>
            <div class="cert-detail">
              ${escapeHtml(certificate.description)}
              ${certificate.expiryDate ? ` &middot; Expires: ${escapeHtml(certificate.expiryDate)}` : ""}
              ${certificate.propertyCategory ? ` &middot; ${escapeHtml(certificate.propertyCategory)}` : ""}
            </div>
          </li>
        `)
        .join("");
    } else {
      marriottEls.certsContainer.style.display = "none";
    }

    marriottEls.rawToggle.style.display = "block";
    marriottEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  marriottEls.syncBtn.addEventListener("click", () => {
    void requestSync("marriott").then((started) => {
      if (started) {
        renderMarriott({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  marriottEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "marriott" });
  });
  marriottEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Marriott Bonvoy")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "marriott" });
    }
  });
  marriottEls.rawToggle.addEventListener("click", () => {
    marriottEls.rawData.classList.toggle("visible");
    marriottEls.rawToggle.textContent = marriottEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  let lastIhgJson = "";
  function renderIhg(state: ProviderSyncState<IHGLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastIhgJson) return;
    lastIhgJson = json;
    const { status, data, error, lastSyncedAt } = state;

    ihgEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    ihgEls.statusText.textContent = STATUS_LABELS[status];
    ihgEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    ihgEls.syncBtn.disabled = isBusy;
    ihgEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync IHG One Rewards";
    ihgEls.cancelBtn.style.display = isBusy ? "block" : "none";
    ihgEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    ihgEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      ihgEls.lastSynced.textContent = `Last synced ${relative}`;
      ihgEls.lastSynced.style.display = "block";
    } else {
      ihgEls.lastSynced.style.display = "none";
    }

    ihgEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      ihgEls.dataSection.style.display = "none";
      ihgEls.rawToggle.style.display = "none";
      return;
    }

    ihgEls.dataSection.style.display = "block";
    renderValue(ihgEls.pointsBalance, data.pointsBalance?.toLocaleString() ?? null);
    renderValue(ihgEls.eliteStatus, data.eliteStatus);
    renderValue(ihgEls.nextTier, data.nextTierName);
    renderValue(
      ihgEls.qualifyingNights,
      data.qualifyingNights?.toLocaleString() ?? null,
    );
    renderValue(
      ihgEls.milestoneNights,
      data.milestoneNightsToNext?.toLocaleString() ?? null,
    );
    renderValue(
      ihgEls.milestoneRewardAt,
      data.nextMilestoneRewardAt != null
        ? `${data.nextMilestoneRewardAt} nights`
        : null,
    );

    if (data.memberName) {
      renderValue(ihgEls.memberName, data.memberName);
      ihgEls.memberNameCard.style.display = "";
    } else {
      ihgEls.memberNameCard.style.display = "none";
    }

    if (data.memberNumber) {
      renderValue(ihgEls.memberNumber, data.memberNumber);
      ihgEls.memberNumberCard.style.display = "";
    } else {
      ihgEls.memberNumberCard.style.display = "none";
    }

    const hasProgress = data.nextTierName != null && data.nightsToNextTier != null;
    ihgEls.progressSection.style.display = hasProgress ? "block" : "none";
    if (hasProgress) {
      ihgEls.progressHeading.textContent = `Progress to ${data.nextTierName}`;
      const currentNights = data.qualifyingNights ?? 0;
      const targetNights = currentNights + (data.nightsToNextTier ?? 0);
      const pct = targetNights > 0
        ? Math.min(100, (currentNights / targetNights) * 100)
        : 0;
      ihgEls.progressCards.innerHTML = `<div class="data-card"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="data-label" style="margin-bottom:0">Qualifying Nights</span><span style="font-size:13px;font-weight:600;color:#342019">${escapeHtml(`${currentNights} of ${targetNights}`)}</span></div><div class="benefit-progress"><div class="benefit-progress-bar" style="width:${pct}%"></div></div></div>`;
    }

    ihgEls.rawToggle.style.display = "block";
    ihgEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  ihgEls.syncBtn.addEventListener("click", () => {
    void requestSync("ihg").then((started) => {
      if (started) {
        renderIhg({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  ihgEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "ihg" });
  });
  ihgEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("IHG One Rewards")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "ihg" });
    }
  });
  ihgEls.rawToggle.addEventListener("click", () => {
    ihgEls.rawData.classList.toggle("visible");
    ihgEls.rawToggle.textContent = ihgEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  let lastHyattJson = "";
  function renderHyatt(state: ProviderSyncState<HyattLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastHyattJson) return;
    lastHyattJson = json;
    const { status, data, error, lastSyncedAt } = state;

    hyattEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    hyattEls.statusText.textContent = STATUS_LABELS[status];
    hyattEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    hyattEls.syncBtn.disabled = isBusy;
    hyattEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync World of Hyatt";
    hyattEls.cancelBtn.style.display = isBusy ? "block" : "none";
    hyattEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    hyattEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      hyattEls.lastSynced.textContent = `Last synced ${relative}`;
      hyattEls.lastSynced.style.display = "block";
    } else {
      hyattEls.lastSynced.style.display = "none";
    }

    hyattEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      hyattEls.dataSection.style.display = "none";
      hyattEls.rawToggle.style.display = "none";
      return;
    }

    hyattEls.dataSection.style.display = "block";
    renderValue(hyattEls.pointsBalance, data.pointsBalance?.toLocaleString() ?? null);
    renderValue(hyattEls.eliteStatus, data.eliteStatus);

    if (data.qualifyingNights) {
      renderValue(hyattEls.qualifyingNights, data.qualifyingNights.toString());
      hyattEls.qualifyingNightsCard.style.display = "";
    } else {
      hyattEls.qualifyingNightsCard.style.display = "none";
    }

    renderValue(hyattEls.memberSince, data.memberSince);

    if (data.memberName) {
      renderValue(hyattEls.memberName, data.memberName);
      hyattEls.memberNameCard.style.display = "";
    } else {
      hyattEls.memberNameCard.style.display = "none";
    }

    if (data.memberNumber) {
      renderValue(hyattEls.memberNumber, data.memberNumber);
      hyattEls.memberNumberCard.style.display = "";
    } else {
      hyattEls.memberNumberCard.style.display = "none";
    }

    const choices = data.milestoneChoices ?? [];
    if (choices.length > 0) {
      hyattEls.milestoneChoicesSection.style.display = "block";
      hyattEls.milestoneChoices.innerHTML = choices
        .map(
          (choice) => `
            <div class="data-list-item">
              <strong>${escapeHtml(choice.name)}</strong>
              ${choice.description ? `<small>${escapeHtml(choice.description)}</small>` : ""}
            </div>
          `,
        )
        .join("");
    } else {
      hyattEls.milestoneChoicesSection.style.display = "none";
    }

    const awards = data.awards ?? [];
    if (awards.length > 0) {
      hyattEls.awardsSection.style.display = "block";
      hyattEls.awards.innerHTML = awards
        .map(
          (award) => `
            <div class="data-list-item">
              <strong>${escapeHtml(award.name)}</strong>
              ${award.description ? `<small>${escapeHtml(award.description)}</small>` : ""}
              ${award.expiryDate ? `<small>Expires: ${escapeHtml(award.expiryDate)}</small>` : ""}
            </div>
          `,
        )
        .join("");
    } else {
      hyattEls.awardsSection.style.display = "none";
    }

    hyattEls.rawToggle.style.display = "block";
    hyattEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  hyattEls.syncBtn.addEventListener("click", () => {
    void requestSync("hyatt").then((started) => {
      if (started) {
        renderHyatt({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  hyattEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "hyatt" });
  });
  hyattEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("World of Hyatt")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "hyatt" });
    }
  });
  hyattEls.rawToggle.addEventListener("click", () => {
    hyattEls.rawData.classList.toggle("visible");
    hyattEls.rawToggle.textContent = hyattEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  let lastHiltonJson = "";
  function renderHilton(state: ProviderSyncState<HiltonLoyaltyData>) {
    const json = JSON.stringify(state);
    if (json === lastHiltonJson) return;
    lastHiltonJson = json;
    const { status, data, error, lastSyncedAt } = state;

    hiltonEls.statusDot.className = `status-dot ${STATUS_DOT_CLASS[status]}`;
    hiltonEls.statusText.textContent = STATUS_LABELS[status];
    hiltonEls.statusSubtitle.textContent = STATUS_SUBTITLES[status];

    const isBusy =
      status === "extracting"
      || status === "detecting_login"
      || status === "waiting_for_login";
    hiltonEls.syncBtn.disabled = isBusy;
    hiltonEls.syncBtn.textContent = isBusy
      ? "Syncing..."
      : status === "done" || status === "cancelled"
        ? "Sync Again"
        : "Sync Hilton Honors";
    hiltonEls.cancelBtn.style.display = isBusy ? "block" : "none";
    hiltonEls.clearBtn.style.display = data && !isBusy ? "block" : "none";
    hiltonEls.loginPrompt.classList.toggle("visible", status === "waiting_for_login");

    const relative = formatRelativeTime(lastSyncedAt);
    if (relative) {
      hiltonEls.lastSynced.textContent = `Last synced ${relative}`;
      hiltonEls.lastSynced.style.display = "block";
    } else {
      hiltonEls.lastSynced.style.display = "none";
    }

    hiltonEls.errorContainer.innerHTML = error
      ? `<div class="error-msg">${escapeHtml(error)}</div>`
      : "";

    if (!data) {
      hiltonEls.dataSection.style.display = "none";
      hiltonEls.rawToggle.style.display = "none";
      return;
    }

    hiltonEls.dataSection.style.display = "block";
    renderValue(hiltonEls.pointsBalance, data.pointsBalance?.toLocaleString() ?? null);
    renderValue(hiltonEls.eliteStatus, data.eliteStatus);

    if (data.memberName) {
      renderValue(hiltonEls.memberName, data.memberName);
      hiltonEls.memberNameCard.style.display = "";
    } else {
      hiltonEls.memberNameCard.style.display = "none";
    }

    if (data.memberNumber) {
      renderValue(hiltonEls.memberNumber, data.memberNumber);
      hiltonEls.memberNumberCard.style.display = "";
    } else {
      hiltonEls.memberNumberCard.style.display = "none";
    }

    const hasProgress = data.nextTierName != null;
    hiltonEls.progressSection.style.display = hasProgress ? "block" : "none";
    if (hasProgress) {
      hiltonEls.progressHeading.textContent = `Progress to ${data.nextTierName}`;

      const trackers: Array<{
        label: string;
        current: number;
        target: number;
        display: string;
      }> = [];
      if (data.nightsToNextTier != null) {
        const current = data.nightsThisYear ?? 0;
        trackers.push({
          label: "Nights",
          current,
          target: data.nightsToNextTier,
          display: `${current} of ${data.nightsToNextTier}`,
        });
      }
      if (data.staysToNextTier != null) {
        const current = data.staysThisYear ?? 0;
        trackers.push({
          label: "Stays",
          current,
          target: data.staysToNextTier,
          display: `${current} of ${data.staysToNextTier}`,
        });
      }
      if (data.spendToNextTier) {
        const parseDollars = (value: string) =>
          parseFloat(value.replace(/[$,KMB]/g, ""))
          * (value.includes("K")
            ? 1000
            : value.includes("M")
              ? 1000000
              : 1);
        const current = parseDollars(data.spendThisYear ?? "$0");
        const target = parseDollars(data.spendToNextTier);
        trackers.push({
          label: "Spend",
          current,
          target,
          display: `${data.spendThisYear ?? "$0"} of ${data.spendToNextTier}`,
        });
      }

      hiltonEls.progressCards.innerHTML = trackers
        .map((tracker) => {
          const pct = tracker.target > 0
            ? Math.min(100, (tracker.current / tracker.target) * 100)
            : 0;
          return `<div class="data-card"><div style="display:flex;justify-content:space-between;align-items:baseline"><span class="data-label" style="margin-bottom:0">${escapeHtml(tracker.label)}</span><span style="font-size:13px;font-weight:600;color:#342019">${escapeHtml(tracker.display)}</span></div><div class="benefit-progress"><div class="benefit-progress-bar" style="width:${pct}%"></div></div></div>`;
        })
        .join("");
    }

    hiltonEls.rawToggle.style.display = "block";
    hiltonEls.rawData.textContent = JSON.stringify(data, null, 2);
  }

  hiltonEls.syncBtn.addEventListener("click", () => {
    void requestSync("hilton").then((started) => {
      if (started) {
        renderHilton({
          status: "detecting_login",
          data: null,
          error: null,
          lastSyncedAt: null,
        });
      }
    });
  });
  hiltonEls.cancelBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "CANCEL_SYNC", provider: "hilton" });
  });
  hiltonEls.clearBtn.addEventListener("click", async () => {
    if (await showConfirmDelete("Hilton Honors")) {
      chrome.runtime.sendMessage({ type: "CLEAR_DATA", provider: "hilton" });
    }
  });
  hiltonEls.rawToggle.addEventListener("click", () => {
    hiltonEls.rawData.classList.toggle("visible");
    hiltonEls.rawToggle.textContent = hiltonEls.rawData.classList.contains("visible")
      ? "Hide raw captured data"
      : "Show raw captured data";
  });

  return {
    renderMarriott,
    renderIhg,
    renderHyatt,
    renderHilton,
  };
}
