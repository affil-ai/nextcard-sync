import { z } from "zod";
import { getAuth } from "../lib/auth";
import {
  getStoredHouseholdContext,
  getSelectedHouseholdMember,
  HOUSEHOLD_CONTEXT_STORAGE_KEY,
  HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY,
} from "../lib/household-context";
import {
  assessDoorDashUsage,
  doorDashMembershipFamily,
  doorDashSnapshotSchema,
  doorDashReplySchema,
  doorDashCardsReplySchema,
  doorDashSaveReplySchema,
  doorDashUsageOptionsReplySchema,
  doorDashExpectedCreditsReplySchema,
  type DoorDashCreditRow,
  doorDashUsageConfirmReplySchema,
  type DoorDashUsageOption,
  type DoorDashSnapshot,
} from "../providers/doordash";

const dashPassUrl = "https://www.doordash.com/manage-subscription";

const viewStoragePrefix = "nextcard_doordash_provider_view_v2::";
const savedViewSchema = z.object({
  scopeKey: z.string(),
  cardLabel: z.string(),
  snapshot: doorDashSnapshotSchema,
});

async function openDashPassPage(tabId: number | undefined, onSignIn: (tabId: number) => void) {
  const tab =
    tabId === undefined
      ? await chrome.tabs.create({ url: dashPassUrl, active: true })
      : await chrome.tabs.update(tabId, { url: dashPassUrl, active: true });
  const openedId = tab.id;
  if (openedId === undefined)
    throw new Error("Could not open DashPass. Try again.");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let waitingForLogin = false;
    const timer = setTimeout(() => finish(new Error("Sign in to DoorDash, then try connecting again.")), 180_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error);
      else resolve();
    }
    async function inspect(checkedId: number) {
      try {
        const current = await chrome.tabs.get(checkedId);
        if (settled || !current.url) return;
        const url = new URL(current.url);
        const signInPage = url.origin === "https://identity.doordash.com" ||
          (url.origin === "https://www.doordash.com" && /^\/(?:consumer\/login|login|post-login)(?:\/|$)/.test(url.pathname));
        if (signInPage) {
          if (!waitingForLogin) onSignIn(checkedId);
          waitingForLogin = true;
          return;
        }
        if (url.origin !== "https://www.doordash.com") {
          finish(new Error("The tab left DoorDash. Try connecting again."));
          return;
        }
        if (current.status === "complete") finish();
      } catch {
        finish(new Error("The DoorDash tab was closed. Try connecting again."));
      }
    }
    function onUpdated(id: number, change: chrome.tabs.TabChangeInfo) {
      if (id === openedId && (change.status === "complete" || change.url)) void inspect(id);
    }
    function onRemoved(id: number) {
      if (id === openedId) finish(new Error("The DoorDash tab was closed. Try connecting again."));
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    void inspect(openedId);
  });
  return openedId;
}

export function mountDoorDashProvider() {
  const root = document.getElementById("doorDashProvider");
  if (!root) return;
  const panel = root;
  const header = document.createElement("button");
  header.type = "button";
  header.className = "provider-card doordash-provider-header";
  const icon = document.createElement("span");
  icon.className = "provider-icon doordash-provider-icon";
  const iconImage = document.createElement("img");
  iconImage.src = new URL("../icons/doordash.svg", import.meta.url).href;
  iconImage.alt = "";
  icon.append(iconImage);
  icon.setAttribute("aria-hidden", "true");
  const info = document.createElement("div");
  info.className = "provider-info";
  const title = document.createElement("div");
  title.className = "provider-name";
  title.textContent = "DoorDash";
  const subtitle = document.createElement("div");
  subtitle.className = "doordash-provider-subtitle";
  subtitle.textContent = "Chase credits";
  const synced = document.createElement("div");
  synced.className = "provider-last-sync";
  synced.setAttribute("role", "status");
  info.append(title, subtitle, synced);
  const body = document.createElement("div");
  body.id = "doorDashConnection";
  body.className = "doordash-connection";
  body.hidden = true;
  const arrow = document.createElement("span");
  arrow.className = "provider-arrow";
  arrow.textContent = "›";
  arrow.setAttribute("aria-hidden", "true");
  header.setAttribute("aria-label", "Connect DoorDash");
  header.setAttribute("aria-controls", body.id);
  function expand(expanded: boolean) {
    body.hidden = !expanded;
  }
  function revealResults() {
    expand(true);
    panel.scrollIntoView?.({
      block: "start",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }
  header.addEventListener("click", () => check.click());
  const tabLabel = document.createElement("label");
  tabLabel.htmlFor = "doorDashTab";
  tabLabel.textContent = "Choose your DoorDash account tab";
  tabLabel.hidden = true;
  const select = document.createElement("select");
  select.id = "doorDashTab";
  select.setAttribute("aria-label", "DoorDash account tab to check");
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh tabs";
  const check = document.createElement("button");
  check.type = "button";
  check.id = "doorDashCheck";
  check.className = "tool-link-btn doordash-refresh-button";
  check.textContent = "Connect";
  const status = document.createElement("p");
  status.id = "doorDashStatus";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const benefits = document.createElement("div");
  benefits.className = "doordash-benefits";
  const creditRows = document.createElement("div");
  creditRows.id = "doorDashCreditRows";
  const saveBox = document.createElement("div");
  saveBox.hidden = true;
  const cardLabel = document.createElement("label");
  cardLabel.htmlFor = "doorDashCard";
  cardLabel.textContent = "nextcard card";
  const cardSelect = document.createElement("select");
  cardSelect.id = "doorDashCard";
  const save = document.createElement("button");
  save.type = "button";
  save.id = "doorDashSave";
  save.className = "sync-btn";
  save.textContent = "Save connection";
  const help = document.createElement("p");
  help.textContent = "Saves availability to nextcard.";
  const mismatch = document.createElement("p");
  mismatch.id = "doorDashCardMismatch";
  mismatch.setAttribute("role", "alert");
  mismatch.hidden = true;
  const manageCards = document.createElement("button");
  manageCards.type = "button";
  manageCards.className = "tool-link-btn";
  manageCards.textContent = "Manage cards";
  manageCards.addEventListener("click", () => {
    void chrome.tabs.create({ url: `${__NEXTCARD_URL__}/dashboard/cards`, active: true });
  });
  saveBox.append(cardLabel, cardSelect, mismatch, manageCards, save, help);
  const actions = document.createElement("div");
  actions.className = "doordash-actions";
  actions.append(refresh);
  header.append(icon, info, arrow);
  body.append(tabLabel, select, actions, status, saveBox, benefits, check);
  const usageBox = document.createElement("div");
  usageBox.hidden = true;
  const usageLabel = document.createElement("label");
  usageLabel.htmlFor = "doorDashUsageCredit";
  usageLabel.textContent = "Credit";
  const usageCredit = document.createElement("select");
  usageCredit.id = "doorDashUsageCredit";
  const countLabel = document.createElement("label");
  countLabel.htmlFor = "doorDashUsageCount";
  countLabel.textContent = "Total uses this period";
  const usageCount = document.createElement("select");
  usageCount.id = "doorDashUsageCount";
  const confirmUsageButton = document.createElement("button");
  confirmUsageButton.type = "button";
  confirmUsageButton.className = "sync-btn";
  confirmUsageButton.textContent = "Mark as used";
  const cancelUsage = document.createElement("button");
  cancelUsage.type = "button";
  cancelUsage.className = "tool-link-btn";
  cancelUsage.textContent = "Cancel";
  usageBox.append(
    usageLabel,
    usageCredit,
    countLabel,
    usageCount,
    confirmUsageButton,
    cancelUsage,
  );
  body.append(usageBox);
  panel.append(header, body);
  let snapshot: DoorDashSnapshot | null = null;
  const matchedCardIds = new Set<string>();
  let usageOptions: DoorDashUsageOption[] = [];
  let usageEntry: HTMLButtonElement | null = null;
  let busy = false;
  let revision = 0;
  let overlayTabId: number | null = null;
  async function showSignInOverlay(tabId: number) {
    try { await chrome.tabs.sendMessage(tabId, { type: "DOORDASH_PAGE_OVERLAY", state: "waiting" }); }
    catch { /* The page script announces when navigation finishes loading it. */ }
  }
  function clearSignInOverlay() {
    const tabId = overlayTabId;
    overlayTabId = null;
    if (tabId !== null) void chrome.tabs.sendMessage(tabId, { type: "DOORDASH_PAGE_OVERLAY", state: "clear" }).catch(() => {});
  }
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab?.id !== overlayTabId || typeof message !== "object" || message === null || !("type" in message) || message.type !== "DOORDASH_OVERLAY_READY") return false;
    if (sender.url && ["https://www.doordash.com", "https://identity.doordash.com"].includes(new URL(sender.url).origin) && overlayTabId !== null) void showSignInOverlay(overlayTabId);
    return false;
  });

  async function currentScopeKey() {
    const auth = await getAuth();
    if (!auth) return null;
    const context = await getStoredHouseholdContext();
    const member = context ? await getSelectedHouseholdMember(context) : null;
    if (context?.householdActivated && !member) return null;
    return JSON.stringify([
      auth.signedInAt,
      context?.accountScopeId ?? null,
      member?.id ?? null,
      member?.lifecycleVersion ?? null,
    ]);
  }
  async function restoreConnection() {
    const expectedRevision = revision;
    try {
      const scopeKey = await currentScopeKey();
      if (!scopeKey) return;
      const storageKey = `${viewStoragePrefix}${scopeKey}`;
      const stored = await chrome.storage.local.get(storageKey);
      const cached = savedViewSchema.safeParse(stored[storageKey]);
      if (
        expectedRevision !== revision ||
        !cached.success ||
        cached.data.scopeKey !== scopeKey
      )
        return;
      snapshot = cached.data.snapshot;
      subtitle.textContent = cached.data.cardLabel;
      synced.textContent = `Synced ${new Date(snapshot.checkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
      check.textContent = "Refresh";
      render(snapshot);
      appendDashboardLink();
    } catch {
      // A missing local summary never prevents an explicit backend sync.
    }
  }
  function appendDashboardLink() {
    if (benefits.querySelector("#doorDashDashboard")) return;
    const dashboard = document.createElement("button");
    dashboard.type = "button";
    dashboard.id = "doorDashDashboard";
    dashboard.className = "tool-link-btn";
    dashboard.textContent = "View in nextcard";
    dashboard.addEventListener("click", () => {
      void chrome.tabs.create({
        url: `${__NEXTCARD_URL__}/dashboard/credits`,
        active: true,
      });
    });
    benefits.append(dashboard);
  }
  function clearResult() {
    snapshot = null;
    usageBox.hidden = true;
    usageOptions = [];
    usageEntry = null;
    benefits.replaceChildren();
    saveBox.hidden = true;
    save.hidden = false;
    matchedCardIds.clear();
    cardSelect.replaceChildren();
    mismatch.hidden = true;
    mismatch.textContent = "";
  }
  async function refreshTabs() {
    const selected = select.value;
    const tabs = await chrome.tabs.query({ url: "https://www.doordash.com/*" });
    select.replaceChildren();
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const option = document.createElement("option");
      option.value = String(tab.id);
      option.textContent = tab.title ?? "DoorDash";
      select.append(option);
    }
    if (tabs.some((tab) => String(tab.id) === selected))
      select.value = selected;
    else {
      const active = tabs.find((tab) => tab.active);
      if (active?.id !== undefined) select.value = String(active.id);
    }
    select.hidden = select.options.length < 2;
    tabLabel.hidden = select.hidden;
    refresh.hidden = select.options.length < 2;
    check.disabled = busy;
  }
  function renderCreditRows(rows: DoorDashCreditRow[]) {
    creditRows.replaceChildren();
    usageEntry = null;
    if (!rows.length) {
      creditRows.textContent = "Credit terms need review. Choose a matching card or sync again.";
      return;
    }
    const currency = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
    for (const row of rows) {
      const item = document.createElement("article");
      item.className = "doordash-credit-row";
      const title = document.createElement("strong");
      title.textContent = `${row.label} · ${row.maxUses > 1 ? `${row.maxUses} × ${currency.format(row.amountPerUse)} credits` : currency.format(row.amountPerUse)}`;
      const period = document.createElement("p");
      const end = new Date(`${row.periodEnd}T12:00:00Z`);
      period.textContent = row.frequency === "quarterly"
        ? `Quarterly · Q${Math.floor(end.getUTCMonth() / 3) + 1} ${end.getUTCFullYear()}`
        : `Monthly · ${end.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}`;
      item.append(title, period);
      const exhausted = row.availability === "likely_used";
      const visibleUses = exhausted ? row.maxUses : row.maxUses > 1 ? Math.min(row.recordedUses ?? 0, row.maxUses) : 1;
      for (let index = 0; index < visibleUses; index++) {
        const recorded = row.recordedUses !== null && row.recordedUses !== undefined && index < row.recordedUses;
        const inferred = !recorded && exhausted;
        const used = recorded || inferred;
        const state = used ? "Used" : row.availability === "likely_used" ? "Likely used" : row.availability === "available" && row.maxUses === 1 ? "Available" : "Usage unknown";
        const slot = document.createElement("div");
        slot.className = "doordash-credit-use";
        slot.dataset.used = String(used);
        slot.dataset.source = recorded ? "recorded" : inferred ? "inferred" : "unknown";
        if (inferred) slot.title = "Inferred from DoorDash promo availability, not a recorded redemption.";
        slot.setAttribute("aria-label", `${row.label}, use ${index + 1} of ${row.maxUses}: ${state}`);
        slot.textContent = `${used ? "✓" : "○"} ${row.maxUses > 1 ? `${currency.format(row.amountPerUse)} · ` : ""}${state}`;
        item.append(slot);
      }
      if (row.maxUses > 1) {
        const remaining = row.maxUses - (row.recordedUses ?? 0);
        if (row.availability === "available" && remaining > 0) {
          const status = document.createElement("div");
          status.className = "doordash-credit-use doordash-credit-status";
          status.textContent = "○ Available";
          item.append(status);
        }
        const note = document.createElement("p");
        note.className = "doordash-credit-availability";
        note.textContent = (row.recordedUses ?? 0) >= row.maxUses
          ? `All ${row.maxUses} credits marked as used.`
          : row.availability === "available"
            ? remaining === 1 ? "1 credit remaining" : `1 or ${remaining} credits remaining`
            : row.availability === "likely_used"
              ? `${row.maxUses} of ${row.maxUses} credits used.`
              : "Availability could not be confirmed.";
        item.append(note);
      }
      if (row.recordedUses === null && row.recordedAmount) {
        const note = document.createElement("p");
        note.textContent = `${currency.format(row.recordedAmount)} recorded. Exact uses unknown.`;
        item.append(note);
      }
      const confirmedUnused = row.maxUses === 1 && row.availability === "available";
      if (row.cardCreditId && row.recordedUses !== row.maxUses && !confirmedUnused && !exhausted) {
        const mark = document.createElement("button");
        mark.type = "button";
        mark.className = "tool-link-btn";
        mark.textContent = row.maxUses === 1 && row.availability === "likely_used" ? "Save usage" : "Mark as used";
        mark.addEventListener("click", () => { void loadUsageOptions(row.cardCreditId); });
        item.append(mark);
      }
      creditRows.append(item);
    }
  }
  async function refreshBenefitRows() {
    if (busy || !snapshot || !matchedCardIds.has(cardSelect.value)) return;
    const currentRevision = revision;
    const selectedCard = cardSelect.value;
    usageBusy(true);
    creditRows.textContent = "Loading credits…";
    try {
      const response = doorDashUsageOptionsReplySchema.parse(await chrome.runtime.sendMessage({ type: "DOORDASH_USAGE_OPTIONS", userCardId: selectedCard }));
      if (currentRevision !== revision || selectedCard !== cardSelect.value) return;
      if (!response.ok) throw new Error(response.error);
      const frequency = assessDoorDashUsage(snapshot).frequency;
      if (!frequency) throw new Error("Promo frequency unknown");
      renderCreditRows(response.options.map((option) => ({ ...option, key: option.cardCreditId, frequency, availability: option.availability ?? "unknown" })));
    } catch {
      if (currentRevision === revision && selectedCard === cardSelect.value)
        creditRows.textContent = "Could not load credit usage. Sync again.";
    } finally {
      usageBusy(false);
    }
  }
  function render(data: DoorDashSnapshot) {
    header.setAttribute("aria-label", "Sync DoorDash");
    benefits.replaceChildren();
    const assessment = assessDoorDashUsage(data);
    const membership = document.createElement("p");
    const membershipName =
      data.membership.find((label) => label.includes(" ")) ??
      data.membership[0]?.replace(/([a-z])([A-Z])/g, "$1 $2");
    membership.textContent = membershipName
      ? `${membershipName.replace(/\s+subscription\b/i, "")}${assessment.frequency ? ` · ${assessment.frequency}` : ""}`
      : "Membership unknown";
    benefits.append(membership);
    creditRows.textContent = "Sync to load your credits.";
    benefits.append(creditRows);
  }
  select.addEventListener("change", () => {
    revision++;
    clearResult();
    status.textContent = "Check this tab to read its current DoorDash account.";
  });
  refresh.addEventListener("click", () => {
    revision++;
    clearResult();
    status.textContent = "Choose the DoorDash account you want to sync.";
    void refreshTabs().catch(() => {
      status.textContent = "Could not list DoorDash tabs. Try again.";
    });
  });
  check.addEventListener("click", async () => {
    if (busy) return;
    expand(false);
    const currentRevision = ++revision;
    let linkedCardToSync: string | null = null;
    clearResult();
    busy = true;
    check.disabled = true;
    select.disabled = true;
    refresh.disabled = true;
    panel.setAttribute("aria-busy", "true");
    status.textContent = "Checking DoorDash benefits…";
    synced.textContent = "Opening DoorDash…";
    check.textContent = "Refreshing…";
    try {
      await refreshTabs();
      if (currentRevision !== revision) return;
      status.textContent = "Opening DashPass…";
      synced.textContent = "Opening DoorDash…";
      const tabId = await openDashPassPage(
        select.value ? Number(select.value) : undefined,
        (tabId) => {
          if (currentRevision !== revision) return;
          status.textContent = "Sign in to DoorDash. Sync will continue automatically.";
          synced.textContent = "Waiting for sign-in…";
          overlayTabId = tabId;
          void showSignInOverlay(tabId);
        },
      );
      if (currentRevision !== revision) return;
      clearSignInOverlay();
      status.textContent = "Checking DoorDash benefits…";
      subtitle.textContent = "Chase credits";
      synced.textContent = "Checking credits…";
      const raw: unknown = await chrome.runtime.sendMessage({
        type: "DOORDASH_TEST_CHECK",
        tabId,
      });
      if (currentRevision !== revision) return;
      const response = doorDashReplySchema.parse(raw);
      if (!response.ok) throw new Error(response.error);
      snapshot = response.snapshot;
      render(snapshot);
      try {
        const expected = doorDashExpectedCreditsReplySchema.parse(await chrome.runtime.sendMessage({ type: "DOORDASH_BENEFITS" }));
        if (currentRevision !== revision) return;
        if (!expected.ok) throw new Error(expected.error);
        renderCreditRows(expected.benefits);
      } catch (error) {
        if (currentRevision === revision) creditRows.textContent = error instanceof Error && !(error instanceof z.ZodError) ? error.message : "Could not load your credits. Try syncing again.";
      }
      synced.textContent = "Loading cards…";
      status.textContent = `Checked ${new Date(snapshot.checkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Loading your nextcard cards…`;
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
        const membershipFamily = assessDoorDashUsage(snapshot).family;
        const matchingCards = cards.cards.filter((card) =>
          Boolean(
            membershipFamily &&
            card.catalogName &&
            doorDashMembershipFamily(card.catalogName) === membershipFamily,
          ),
        );
        for (const card of matchingCards) matchedCardIds.add(card.userCardId);
        const otherCards = cards.cards.filter((card) => !matchedCardIds.has(card.userCardId));
        for (const [label, groupCards] of [
          ["Matching cards", matchingCards],
          ["Other cards", otherCards],
        ] satisfies [string, typeof cards.cards][]) {
          if (!groupCards.length) continue;
          const group = document.createElement("optgroup");
          group.label = label;
          for (const card of groupCards) {
            const option = document.createElement("option");
            option.value = card.userCardId;
            const nickname = card.catalogName && card.name.trim() !== card.catalogName.trim()
              ? ` (${card.name.trim()})` : "";
            option.textContent = `${card.catalogName ?? card.name}${nickname}${card.lastFourDigits ? ` · ${card.lastFourDigits}` : ""}`;
            group.append(option);
          }
          cardSelect.append(group);
        }
        save.disabled = true;
        if (
          cards.connectedUserCardId &&
          matchedCardIds.has(cards.connectedUserCardId)
        ) {
          cardSelect.value = cards.connectedUserCardId;
          linkedCardToSync = cards.connectedUserCardId;
          save.disabled = false;
        }
        saveBox.hidden = false;
        cardSelect.hidden = cards.cards.length === 0;
        cardLabel.hidden = cardSelect.hidden;
        save.hidden = cardSelect.hidden;
        manageCards.textContent = cards.cards.length ? "Manage cards" : "Add a card";
        if (usageEntry) usageEntry.hidden = matchingCards.length === 0;
        status.textContent = cards.cards.length ? "Choose your linked card." : "Add a card to connect DoorDash.";
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
      clearSignInOverlay();
      expand(true);
      if (!snapshot) subtitle.textContent = "Chase credits";
      busy = false;
      check.disabled = false;
      check.textContent = snapshot ? "Refresh" : "Connect";
      select.disabled = false;
      refresh.disabled = false;
      panel.removeAttribute("aria-busy");
      synced.textContent = snapshot ? "Checked just now" : "Sync failed. Try again.";
      if (currentRevision === revision && !linkedCardToSync) revealResults();
    }
    updateCardMatch();
    if (linkedCardToSync && currentRevision === revision && !save.disabled)
      save.click();
  });
  function updateCardMatch() {
    const differs = Boolean(
      cardSelect.value && !matchedCardIds.has(cardSelect.value),
    );
    mismatch.hidden = !differs;
    mismatch.textContent = differs
      ? "This card’s product does not match your DoorDash membership. Update it in nextcard, then sync again."
      : "";
    save.disabled =
      busy || !cardSelect.value || !matchedCardIds.has(cardSelect.value);
    if (usageEntry) usageEntry.disabled = save.disabled;
  }
  cardSelect.addEventListener("change", () => {
    usageBox.hidden = true;
    usageOptions = [];
    if (usageEntry) usageEntry.hidden = false;
    updateCardMatch();
    void refreshBenefitRows();
  });
  function usageBusy(value: boolean) {
    busy = value;
    check.disabled = value;
    save.disabled = value;
    select.disabled = value;
    cardSelect.disabled = value;
    refresh.disabled = value;
    usageCredit.disabled = value;
    usageCount.disabled = value;
    confirmUsageButton.disabled = value;
    cancelUsage.disabled = value;
    if (usageEntry) usageEntry.disabled = value;
    if (!value) updateCardMatch();
  }
  function renderUsageCount() {
    const option = usageOptions.find(
      (item) => item.cardCreditId === usageCredit.value,
    );
    usageCount.replaceChildren();
    usageCount.add(new Option("Choose uses", ""));
    if (option) {
      for (let uses = 1; uses <= option.maxUses; uses++)
        usageCount.add(new Option(`${uses} used`, String(uses)));
      if (option.maxUses === 1) usageCount.value = "1";
    }
    countLabel.hidden = option?.maxUses === 1;
    usageCount.hidden = countLabel.hidden;
    confirmUsageButton.disabled = !option || !usageCount.value;
  }
  async function confirmUsage(option: DoorDashUsageOption, uses: number) {
    if (busy || !snapshot || !cardSelect.value) return;
    const currentRevision = revision;
    usageBusy(true);
    status.textContent = "Saving usage…";
    let savedUsage = false;
    try {
      const response = doorDashUsageConfirmReplySchema.parse(
        await chrome.runtime.sendMessage({
          type: "DOORDASH_USAGE_CONFIRM",
          userCardId: cardSelect.value,
          confirmation: {
            cardCreditId: option.cardCreditId,
            periodStart: option.periodStart,
            periodEnd: option.periodEnd,
            uses,
          },
        }),
      );
      if (currentRevision !== revision) return;
      if (!response.ok) throw new Error(response.error);
      usageBox.hidden = true;
      saveBox.hidden = true;
      savedUsage = true;
      subtitle.textContent =
        cardSelect.selectedOptions[0]?.textContent ?? "Connected card";
      synced.textContent = "Usage saved";
      check.textContent = "Refresh";
      status.textContent = "";
      appendDashboardLink();
    } catch (error) {
      if (currentRevision === revision)
        status.textContent =
          error instanceof Error
            ? error.message
            : "Could not save usage. Try again.";
    } finally {
      usageBusy(false);
    }
    if (savedUsage && currentRevision === revision) await refreshBenefitRows();
  }
  async function loadUsageOptions(cardCreditId?: string) {
    updateCardMatch();
    if (busy || !snapshot || !cardSelect.value || save.disabled) return;
    const currentRevision = revision;
    usageBusy(true);
    status.textContent = "Loading credit…";
    let single: DoorDashUsageOption | undefined;
    try {
      const parsed = doorDashUsageOptionsReplySchema.safeParse(
        await chrome.runtime.sendMessage({
          type: "DOORDASH_USAGE_OPTIONS",
          userCardId: cardSelect.value,
        }),
      );
      if (!parsed.success)
        throw new Error(
          "Usage confirmation needs the backend update. Usage unchanged.",
        );
      const response = parsed.data;
      if (currentRevision !== revision) return;
      if (!response.ok) throw new Error(response.error);
      usageOptions = cardCreditId ? response.options.filter((option) => option.cardCreditId === cardCreditId) : response.options;
      if (!usageOptions.length)
        throw new Error(
          "No matching credit found. Check your card and sync again.",
        );
      usageCredit.replaceChildren();
      usageCredit.add(new Option("Choose credit", ""));
      for (const option of usageOptions)
        usageCredit.add(
          new Option(
            `${option.label} · ${option.periodStart} to ${option.periodEnd}`,
            option.cardCreditId,
          ),
        );
      if (usageOptions.length === 1) {
        usageCredit.value = usageOptions[0]?.cardCreditId ?? "";
        single = usageOptions[0]?.maxUses === 1 ? usageOptions[0] : undefined;
      }
      usageLabel.hidden = usageOptions.length === 1;
      usageCredit.hidden = usageLabel.hidden;
      usageBox.hidden = false;
      for (const button of creditRows.querySelectorAll("button")) button.hidden = true;
      save.hidden = true;
      if (usageEntry) usageEntry.hidden = true;
      status.textContent = "Confirm total uses for this period.";
    } catch (error) {
      if (currentRevision === revision)
        status.textContent =
          error instanceof Error
            ? error.message
            : "Could not load credit. Try again.";
    } finally {
      usageBusy(false);
      renderUsageCount();
    }
    if (single && currentRevision === revision) await confirmUsage(single, 1);
  }
  usageCredit.addEventListener("change", renderUsageCount);
  usageCount.addEventListener("change", () => {
    confirmUsageButton.disabled = !usageCredit.value || !usageCount.value;
  });
  confirmUsageButton.addEventListener("click", () => {
    const option = usageOptions.find(
      (item) => item.cardCreditId === usageCredit.value,
    );
    if (option && usageCount.value)
      void confirmUsage(option, Number(usageCount.value));
  });
  cancelUsage.addEventListener("click", () => {
    usageBox.hidden = true;
    if (usageEntry) usageEntry.hidden = false;
    save.hidden = false;
    for (const button of creditRows.querySelectorAll("button")) button.hidden = false;
    status.textContent = "Usage unchanged.";
  });
  save.addEventListener("click", async () => {
    updateCardMatch();
    if (busy || !snapshot || !cardSelect.value || save.disabled) return;
    busy = true;
    const currentRevision = ++revision;
    save.disabled = true;
    check.disabled = true;
    refresh.disabled = true;
    select.disabled = true;
    cardSelect.disabled = true;
    status.textContent =
      "Rechecking the DoorDash account and saving availability…";
    let savedConnection = false;
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
      savedConnection = true;
      render(snapshot);
      saveBox.hidden = true;
      subtitle.textContent =
        cardSelect.selectedOptions[0]?.textContent ?? "Connected card";
      synced.textContent = `Synced ${new Date(snapshot.checkedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
      check.textContent = "Refresh";
      status.textContent = "Saved to nextcard.";
      appendDashboardLink();
      try {
        const scopeKey = await currentScopeKey();
        if (currentRevision !== revision) return;
        if (scopeKey)
          await chrome.storage.local.set({
            [`${viewStoragePrefix}${scopeKey}`]: {
              scopeKey,
              cardLabel: subtitle.textContent,
              snapshot,
            },
          });
      } catch {
        // The backend already acknowledged the save; this summary is optional.
      }
      expand(true);
    } catch (error) {
      status.textContent =
        error instanceof Error
          ? error.message
          : "Could not save. Check again and retry.";
      save.disabled = false;
    } finally {
      busy = false;
      check.disabled = false;
      check.textContent = snapshot ? "Refresh" : "Connect";
      refresh.disabled = false;
      select.disabled = false;
      cardSelect.disabled = false;
    }
    if (savedConnection && currentRevision === revision) await refreshBenefitRows();
    if (currentRevision === revision) revealResults();
  });
  function resetConnection() {
    clearSignInOverlay();
    header.setAttribute("aria-label", "Connect DoorDash");
    revision++;
    clearResult();
    subtitle.textContent = "Chase credits";
    synced.textContent = "";
    status.textContent = "";
    check.textContent = "Connect";
    expand(false);
  }
  document
    .getElementById("householdMemberSelect")
    ?.addEventListener("change", resetConnection);
  document
    .getElementById("userSignOutBtn")
    ?.addEventListener("click", resetConnection);
  chrome.storage?.onChanged?.addListener((changes, areaName) => {
    if (
      areaName === "local" &&
      ("nextcard_auth" in changes ||
        HOUSEHOLD_SELECTED_MEMBER_STORAGE_KEY in changes ||
        HOUSEHOLD_CONTEXT_STORAGE_KEY in changes)
    ) {
      resetConnection();
      void restoreConnection();
    }
  });
  void restoreConnection();
  void refreshTabs().catch(() => {
    status.textContent = "Could not list DoorDash tabs. Try refreshing.";
  });
}
