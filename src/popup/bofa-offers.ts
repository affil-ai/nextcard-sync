import { z } from "zod";
import {
  bofaPortalStateSchema,
  type PortalOffer,
} from "../providers/bofa-offers";

const responseSchema = z.object({
  ok: z.boolean(),
  state: bofaPortalStateSchema.nullable().optional(),
  error: z.string().optional(),
});
const labels: Record<PortalOffer["action"], string> = {
  ready: "Ready to use",
  activate: "Activate",
  activated: "Activated",
  shop_through_issuer: "Shop through BofA",
  merchant_deal: "View merchant deal",
};

export function mountBofaOffers() {
  const root = document.getElementById("bofaOffersPanel");
  if (!root) return;
  const check = document.createElement("button");
  check.type = "button";
  check.className = "sync-btn";
  check.textContent = "Check BofA offers";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "tool-link-btn";
  cancel.textContent = "Stop";
  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search BofA offers";
  search.setAttribute("aria-label", "Search BofA offers");
  const filter = document.createElement("select");
  filter.setAttribute("aria-label", "BofA offer action");
  for (const [value, label] of [
    ["all", "All offers"],
    ...Object.entries(labels),
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    filter.append(option);
  }
  const selectAll = document.createElement("button");
  selectAll.type = "button";
  selectAll.className = "tool-link-btn";
  selectAll.textContent = "Select all offers needing activation";
  const activate = document.createElement("button");
  activate.type = "button";
  activate.className = "sync-btn";
  activate.textContent = "Activate selected offers";
  const list = document.createElement("div");
  list.className = "offer-review-list";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "tool-link-btn";
  more.textContent = "Show more offers";
  root.append(
    check,
    cancel,
    status,
    search,
    filter,
    selectAll,
    activate,
    list,
    more,
  );
  let state: z.infer<typeof bofaPortalStateSchema> | null = null;
  let selected = new Set<string>();
  let limit = 50;
  let lastFingerprint = "";
  let actionPending = false;
  let actionError: string | null = null;
  async function send(message: object) {
    const raw: unknown = await chrome.runtime.sendMessage(message);
    return responseSchema.parse(raw);
  }
  function renderOffers() {
    list.replaceChildren();
    const query = search.value.trim().toLowerCase();
    const visible = (state?.offers ?? []).filter(
      (o) =>
        (filter.value === "all" || o.action === filter.value) &&
        `${o.merchantName} ${o.offerValue ?? ""}`.toLowerCase().includes(query),
    );
    for (const offer of visible.slice(0, limit)) {
      const row = document.createElement("div");
      row.className = "offer-review-row";
      const title = document.createElement("strong");
      title.textContent = offer.merchantName;
      const value = document.createElement("p");
      value.textContent = offer.offerValue;
      const action = document.createElement("p");
      action.textContent = labels[offer.action];
      if (offer.action === "activate") {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = selected.has(offer.issuerOfferId);
        input.disabled = state?.phase !== "ready";
        input.onchange = () => {
          if (input.checked) selected.add(offer.issuerOfferId);
          else selected.delete(offer.issuerOfferId);
          updateButtons();
        };
        label.append(input, title);
        row.append(label);
      } else row.append(title);
      const link = document.createElement("a");
      link.href = `https://deals.merchant-rewards.com/offers/${encodeURIComponent(offer.issuerOfferId)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent =
        offer.action === "shop_through_issuer"
          ? "Shop through BofA"
          : offer.action === "activate"
            ? "Review and activate on BofA"
            : "View on BofA";
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Details and terms";
      const terms = document.createElement("p");
      terms.textContent = [offer.detailsText, offer.termsText].join("\n\n");
      details.append(summary, terms);
      row.append(value, action, link, details);
      list.append(row);
    }
    more.hidden = visible.length <= limit;
  }
  function updateButtons() {
    const running =
      state?.phase === "checking" || state?.phase === "activating";
    check.disabled = running || actionPending;
    cancel.hidden = !running;
    activate.disabled =
      state?.phase !== "ready" || selected.size === 0 || actionPending;
    activate.textContent = `Activate ${selected.size} selected offer${selected.size === 1 ? "" : "s"}`;
    selectAll.disabled = state?.phase !== "ready";
    search.hidden = !state?.offers.length;
    filter.hidden = search.hidden;
    selectAll.hidden = search.hidden;
    activate.hidden = search.hidden;
  }
  function apply(next: z.infer<typeof bofaPortalStateSchema> | null) {
    if (state?.runId !== next?.runId) {
      selected = new Set();
      limit = 50;
    }
    state = next;
    if (!state) {
      list.replaceChildren();
      status.textContent =
        actionError ??
        "One set of offers for your BofA portal. Checkout requires an eligible BofA card. Upside is excluded.";
      updateButtons();
      more.hidden = true;
      return;
    }
    selected = new Set(
      [...selected].filter((id) =>
        state?.offers.some(
          (o) => o.issuerOfferId === id && o.action === "activate",
        ),
      ),
    );
    const counts = Object.entries(labels)
      .map(
        ([action, label]) =>
          `${state?.offers.filter((o) => o.action === action).length ?? 0} ${label.toLowerCase()}`,
      )
      .join(" · ");
    status.textContent = `${actionError ? `${actionError} ` : ""}${state.error ? `${state.error} ` : ""}${state.phase === "checking" ? (state.total ? `Reading ${state.checked} of ${state.total} offers. ` : "Checking the complete BofA inventory. ") : `${state.offers.length} offers. `}${counts}. ${state.saveStatus === "queued_for_retry" ? "Some offers are waiting to save. Check again to retry." : state.saveStatus === "saved" ? "Saved to nextcard." : "Saving to nextcard."}`;
    const fingerprint = JSON.stringify([
      state.runId,
      state.phase,
      state.offers.length,
      state.added,
      state.failed,
      search.value,
      filter.value,
    ]);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      renderOffers();
    }
    updateButtons();
  }
  async function action(message: object) {
    actionError = null;
    actionPending = true;
    updateButtons();
    try {
      const result = await send(message);
      if (result.ok) apply(result.state ?? null);
      else {
        actionError = result.error ?? "BofA operation failed.";
        status.textContent = actionError;
      }
    } catch (error) {
      actionError =
        error instanceof Error
          ? error.message
          : "Could not contact the extension.";
      status.textContent = actionError;
    } finally {
      actionPending = false;
      updateButtons();
    }
  }
  check.onclick = () => {
    status.textContent = "Opening BofA deals. Sign in to BofA if asked.";
    void action({ type: "BOFA_PORTAL_CHECK" });
  };
  cancel.onclick = () => {
    void action({ type: "BOFA_PORTAL_CANCEL" });
  };
  activate.onclick = () => {
    if (state)
      void action({
        type: "BOFA_PORTAL_ACTIVATE",
        runId: state.runId,
        ids: [...selected],
      });
  };
  selectAll.onclick = () => {
    selected = new Set(
      (state?.offers ?? [])
        .filter((o) => o.action === "activate")
        .map((o) => o.issuerOfferId),
    );
    renderOffers();
    updateButtons();
  };
  search.oninput = filter.onchange = () => {
    limit = 50;
    renderOffers();
  };
  more.onclick = () => {
    limit += 50;
    renderOffers();
  };
  apply(null);
  async function poll() {
    if (actionPending) return;
    try {
      const result = await send({ type: "BOFA_PORTAL_STATUS" });
      if (result.ok) apply(result.state ?? null);
    } catch {
      /* A worker can restart between polls. */
    }
  }
  void poll();
  const timer = setInterval(() => {
    void poll();
  }, 1500);
  window.addEventListener("pagehide", () => clearInterval(timer), {
    once: true,
  });
}
