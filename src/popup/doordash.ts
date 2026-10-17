import { doorDashReplySchema, type DoorDashSnapshot } from "../providers/doordash";

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
  check.textContent = "Check benefits";
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
  const actions = document.createElement("div");
  actions.className = "doordash-actions";
  actions.append(open, refresh, check, copy);
  panel.append(select, actions, status, result);
  let snapshot: DoorDashSnapshot | null = null;
  let busy = false;
  let revision = 0;

  function clearResult() {
    snapshot = null;
    copy.hidden = true;
    result.replaceChildren();
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
    if (tabs.some((tab) => String(tab.id) === selected)) select.value = selected;
    else {
      const active = tabs.find((tab) => tab.active);
      if (active?.id !== undefined) select.value = String(active.id);
    }
    check.disabled = busy || select.options.length === 0;
    if (!select.options.length) status.textContent = "Open DoorDash, sign in, then refresh tabs.";
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
    row("Benefit eligibility", data.eligibleForBenefits === null ? "Unknown" : data.eligibleForBenefits ? "Eligible" : "Not eligible");
    if (data.activationDate) row("Activation", new Date(data.activationDate).toLocaleDateString());
    if (data.accountKey) row("Test account", data.accountKey);
    if (data.billingInterval) row("DashPass billing interval", `${data.billingInterval}, separate from promo frequency`);
    for (const campaign of data.campaigns) {
      const card = document.createElement("article");
      card.className = "doordash-campaign";
      const title = document.createElement("strong");
      title.textContent = campaign.title;
      const state = document.createElement("p");
      state.textContent = "Offered by DoorDash. Exact remaining uses unknown.";
      const detail = document.createElement("p");
      detail.textContent = [...campaign.descriptions, `Promo frequency: ${campaign.frequency}`, ...(campaign.allowance !== null ? [`Allowance: ${campaign.allowance} per period, not a remaining count`] : [])].join(" · ");
      const id = document.createElement("code");
      id.textContent = campaign.campaignId;
      card.append(title, state, detail, id);
      result.append(card);
    }
    if (!data.campaigns.length) row("Campaigns", "No Chase campaigns observed. This does not confirm they were used.");
    row("Checkout contexts checked", String(data.checkoutContextsChecked));
    if (!data.checkoutContextsChecked) row("More complete check", "Add an item at an eligible store on DoorDash, then check again. The extension reads your existing cart without changing it.");
    for (const message of data.validationMessages) row("DoorDash validation", message);
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
    status.textContent = "Choose the tab signed into the account you want to test.";
    void refreshTabs().catch(() => { status.textContent = "Could not list DoorDash tabs. Try again."; });
  });
  open.addEventListener("click", () => {
    void chrome.tabs.create({ url: "https://www.doordash.com/", active: true });
  });
  check.addEventListener("click", async () => {
    if (busy || !select.value) return;
    const currentRevision = ++revision;
    clearResult();
    busy = true;
    check.disabled = true;
    select.disabled = true;
    refresh.disabled = true;
    panel.setAttribute("aria-busy", "true");
    status.textContent = "Reading DoorDash membership and campaigns…";
    try {
      const raw: unknown = await chrome.runtime.sendMessage({ type: "DOORDASH_TEST_CHECK", tabId: Number(select.value) });
      if (currentRevision !== revision) return;
      const response = doorDashReplySchema.parse(raw);
      if (!response.ok) throw new Error(response.error);
      snapshot = response.snapshot;
      render(snapshot);
      copy.hidden = false;
      status.textContent = `Checked ${new Date(snapshot.checkedAt).toLocaleString()}. Check again after switching accounts. Results stay in this panel and are not saved to your Nextcard credit totals.`;
    } catch (error) {
      if (currentRevision === revision) status.textContent = error instanceof Error ? error.message : "DoorDash check failed. Retry.";
    } finally {
      busy = false;
      check.disabled = select.options.length === 0;
      select.disabled = false;
      refresh.disabled = false;
      panel.removeAttribute("aria-busy");
    }
  });
  copy.addEventListener("click", async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      status.textContent = "Copied normalized test results. No cookies, tokens, order details, or payment details are included.";
    } catch {
      status.textContent = "Could not copy the result. Keep this panel open to review it.";
    }
  });
  void refreshTabs().catch(() => { status.textContent = "Could not list DoorDash tabs. Try refreshing."; });
}
