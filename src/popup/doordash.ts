import {
  doorDashReplySchema,
  doorDashCardsReplySchema,
  doorDashSaveReplySchema,
  type DoorDashSnapshot,
} from "../providers/doordash";

export function mountDoorDashTest() {
  const root = document.getElementById("doorDashTest");
  if (!root) return;
  const panel = root;
  const select = document.createElement("select");
  select.id = "doorDashTab";
  select.setAttribute("aria-label", "DoorDash account tab to check");
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open DoorDash";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh tabs";
  const check = document.createElement("button");
  check.type = "button";
  check.id = "doorDashCheck";
  check.className = "sync-btn";
  check.textContent = "Sync benefits";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy test result";
  copy.hidden = true;
  const status = document.createElement("p");
  status.id = "doorDashStatus";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const result = document.createElement("div");
  result.id = "doorDashResult";
  const saveBox = document.createElement("div");
  saveBox.hidden = true;
  const cardLabel = document.createElement("label");
  cardLabel.htmlFor = "doorDashCard";
  cardLabel.textContent = "Which Nextcard card owns this DoorDash membership?";
  const cardSelect = document.createElement("select");
  cardSelect.id = "doorDashCard";
  const save = document.createElement("button");
  save.type = "button";
  save.id = "doorDashSave";
  save.className = "sync-btn";
  save.textContent = "Save availability to Nextcard";
  const help = document.createElement("p");
  help.textContent =
    "Saves available, likely used, or unknown for the current benefit period. Exact dollar usage stays separate.";
  saveBox.append(cardLabel, cardSelect, save, help);
  const actions = document.createElement("div");
  actions.className = "doordash-actions";
  actions.append(open, refresh, check, copy);
  panel.append(select, actions, status, saveBox, result);
  let snapshot: DoorDashSnapshot | null = null;
  let busy = false;
  let revision = 0;

  function clearResult() {
    snapshot = null;
    copy.hidden = true;
    result.replaceChildren();
    saveBox.hidden = true;
    cardSelect.replaceChildren();
  }
  async function refreshTabs() {
    const selected = select.value;
    const tabs = await chrome.tabs.query({ url: "https://www.doordash.com/*" });
    select.replaceChildren();
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const option = document.createElement("option");
      option.value = String(tab.id);
      option.textContent = `${tab.title ?? "DoorDash"} · tab ${tab.id}`;
      select.append(option);
    }
    if (tabs.some((tab) => String(tab.id) === selected))
      select.value = selected;
    else {
      const active = tabs.find((tab) => tab.active);
      if (active?.id !== undefined) select.value = String(active.id);
    }
    check.disabled = busy || select.options.length === 0;
    if (!select.options.length)
      status.textContent = "Open DoorDash, sign in, then refresh tabs.";
  }
  function row(label: string, value: string) {
    const p = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    p.append(strong, value);
    result.append(p);
  }
  function render(data: DoorDashSnapshot) {
    row("Membership", data.membership.join(" · ") || "Not identified");
    row("Plan", data.planId ?? "Unknown");
    row("Status", data.subscriptionStatus ?? "Unknown");
    row(
      "Benefit eligibility",
      data.eligibleForBenefits === null
        ? "Unknown"
        : data.eligibleForBenefits
          ? "Eligible"
          : "Not eligible",
    );
    if (data.activationDate)
      row("Activation", new Date(data.activationDate).toLocaleDateString());
    if (data.accountKey) row("Test account", data.accountKey);
    if (data.billingInterval)
      row(
        "DashPass billing interval",
        `${data.billingInterval}, separate from promo frequency`,
      );
    for (const campaign of data.campaigns) {
      const card = document.createElement("article");
      card.className = "doordash-campaign";
      const title = document.createElement("strong");
      title.textContent = campaign.title;
      const state = document.createElement("p");
      state.textContent = "Offered by DoorDash. Exact remaining uses unknown.";
      const detail = document.createElement("p");
      detail.textContent = [
        ...campaign.descriptions,
        `Promo frequency: ${campaign.frequency}`,
        ...(campaign.allowance !== null
          ? [
              `Allowance: ${campaign.allowance} per period, not a remaining count`,
            ]
          : []),
      ].join(" · ");
      const id = document.createElement("code");
      id.textContent = campaign.campaignId;
      card.append(title, state, detail, id);
      result.append(card);
    }
    if (!data.campaigns.length)
      row(
        "Campaigns",
        "No Chase campaigns observed. This does not confirm they were used.",
      );
    row("Checkout contexts checked", String(data.checkoutContextsChecked));
    if (!data.checkoutContextsChecked)
      row(
        "More complete check",
        "Add an item at an eligible store on DoorDash, then check again. The extension reads your existing cart without changing it.",
      );
    for (const message of data.validationMessages)
      row("DoorDash validation", message);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Request checks";
    details.append(summary);
    for (const item of data.checks) {
      const p = document.createElement("p");
      p.textContent = `${item.source}: ${item.status}${item.error ? `, ${item.error}` : ""}`;
      details.append(p);
    }
    result.append(details);
  }
  select.addEventListener("change", () => {
    revision++;
    clearResult();
    status.textContent = "Check this tab to read its current DoorDash account.";
  });
  refresh.addEventListener("click", () => {
    revision++;
    clearResult();
    status.textContent =
      "Choose the tab signed into the account you want to test.";
    void refreshTabs().catch(() => {
      status.textContent = "Could not list DoorDash tabs. Try again.";
    });
  });
  open.addEventListener("click", () => {
    void chrome.tabs.create({ url: "https://www.doordash.com/", active: true });
  });
  check.addEventListener("click", async () => {
    if (busy || !select.value) return;
    const currentRevision = ++revision;
    let linkedCardToSync: string | null = null;
    clearResult();
    busy = true;
    check.disabled = true;
    select.disabled = true;
    refresh.disabled = true;
    panel.setAttribute("aria-busy", "true");
    status.textContent = "Reading DoorDash membership and campaigns…";
    try {
      const raw: unknown = await chrome.runtime.sendMessage({
        type: "DOORDASH_TEST_CHECK",
        tabId: Number(select.value),
      });
      if (currentRevision !== revision) return;
      const response = doorDashReplySchema.parse(raw);
      if (!response.ok) throw new Error(response.error);
      snapshot = response.snapshot;
      render(snapshot);
      copy.hidden = false;
      status.textContent = `Checked ${new Date(snapshot.checkedAt).toLocaleString()}. Loading your Nextcard cards…`;
      try {
        const cards = doorDashCardsReplySchema.parse(
          await chrome.runtime.sendMessage({ type: "DOORDASH_TEST_CARDS" }),
        );
        if (currentRevision !== revision) return;
        if (!cards.ok) throw new Error(cards.error);
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Choose your card";
        cardSelect.append(placeholder);
        for (const card of cards.cards) {
          const option = document.createElement("option");
          option.value = card.userCardId;
          option.textContent = `${card.name}${card.lastFourDigits ? ` · ${card.lastFourDigits}` : ""}`;
          cardSelect.append(option);
        }
        save.disabled = true;
        if (
          cards.connectedUserCardId &&
          cards.cards.some(
            (card) => card.userCardId === cards.connectedUserCardId,
          )
        ) {
          cardSelect.value = cards.connectedUserCardId;
          linkedCardToSync = cards.connectedUserCardId;
          save.disabled = false;
        }
        saveBox.hidden = false;
        status.textContent = cards.cards.length
          ? "Choose the card that owns this DoorDash membership, then save. Check again after switching accounts."
          : "No cards with DoorDash benefits were found in the selected Nextcard profile. Add the card to your wallet, then check again.";
      } catch (error) {
        status.textContent = `DoorDash was checked, but saving is unavailable. ${error instanceof Error ? error.message : "Retry the check."}`;
      }
    } catch (error) {
      if (currentRevision === revision)
        status.textContent =
          error instanceof Error
            ? error.message
            : "DoorDash check failed. Retry.";
    } finally {
      busy = false;
      check.disabled = select.options.length === 0;
      select.disabled = false;
      refresh.disabled = false;
      panel.removeAttribute("aria-busy");
    }
    if (linkedCardToSync && currentRevision === revision) save.click();
  });
  cardSelect.addEventListener("change", () => {
    save.disabled = busy || !cardSelect.value;
  });
  save.addEventListener("click", async () => {
    if (busy || !snapshot || !cardSelect.value) return;
    busy = true;
    const currentRevision = ++revision;
    save.disabled = true;
    check.disabled = true;
    refresh.disabled = true;
    select.disabled = true;
    cardSelect.disabled = true;
    status.textContent =
      "Rechecking the DoorDash account and saving availability…";
    try {
      const response = doorDashSaveReplySchema.parse(
        await chrome.runtime.sendMessage({
          type: "DOORDASH_TEST_SAVE",
          userCardId: cardSelect.value,
        }),
      );
      if (currentRevision !== revision) return;
      if (!response.ok) throw new Error(response.error);
      snapshot = response.snapshot;
      result.replaceChildren();
      render(snapshot);
      saveBox.hidden = true;
      status.textContent = `Saved ${response.saved} benefit observations to ${cardSelect.selectedOptions[0]?.textContent ?? "your card"}. Open Nextcard's credits dashboard to see availability. Recorded dollar usage was not changed.`;
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Could not save. Check again and retry.";
      save.disabled = false;
    } finally {
      busy = false;
      check.disabled = select.options.length === 0;
      refresh.disabled = false;
      select.disabled = false;
      cardSelect.disabled = false;
    }
  });
  copy.addEventListener("click", async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      status.textContent =
        "Copied normalized test results. No cookies, tokens, order details, or payment details are included.";
    } catch {
      status.textContent =
        "Could not copy the result. Keep this panel open to review it.";
    }
  });
  void refreshTabs().catch(() => {
    status.textContent = "Could not list DoorDash tabs. Try refreshing.";
  });
}
