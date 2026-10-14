import { z } from "zod";
import { bofaPortalStateSchema } from "../providers/bofa-offers";
import type { OfferOperationCard } from "../lib/offer-operation";
import { OfferReview } from "./offer-review";

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), state: bofaPortalStateSchema.nullable() }),
  z.object({ ok: z.literal(false), error: z.string().optional() }),
]);

export function mountBofaOffers() {
  const container = document.getElementById("bofaOffersCard");
  if (!container) return;
  const root = container;
  root.className = "provider-card tool-card";
  const icon = document.createElement("div");
  icon.className = "provider-icon";
  const image = document.createElement("img");
  image.src = new URL("../icons/bofa.jpg", import.meta.url).href;
  image.alt = "Bank of America";
  icon.append(image);
  const info = document.createElement("div");
  info.className = "provider-info";
  const name = document.createElement("div");
  name.className = "provider-name";
  name.textContent = "Bank of America";
  const description = document.createElement("div");
  description.className = "provider-desc";
  info.append(name, description);
  const check = document.createElement("button");
  check.id = "bofaOffersDiscoverBtn";
  check.type = "button";
  check.className = "offer-row-action";
  check.setAttribute("aria-label", "Check Bank of America offers");
  const body = document.createElement("div");
  body.className = "tool-expand";
  const status = document.createElement("div");
  status.className = "tool-status";
  status.setAttribute("aria-live", "polite");
  const notice = document.createElement("div");
  notice.className = "error-box";
  notice.setAttribute("role", "alert");
  const signIn = document.createElement("button");
  signIn.type = "button";
  signIn.className = "sync-btn";
  signIn.textContent = "Sign in to Bank of America";
  const progress = document.createElement("div");
  progress.className = "offers-progress-bar";
  progress.setAttribute("role", "progressbar");
  const fill = document.createElement("div");
  fill.className = "offers-progress-bar-fill";
  progress.append(fill);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "tool-link-btn";
  cancel.textContent = "Stop";
  const reviewHost = document.createElement("div");
  reviewHost.className = "offer-review";
  const review = new OfferReview();
  const actions = document.createElement("div");
  actions.className = "offer-enrollment-actions";
  const activateAll = document.createElement("button");
  activateAll.type = "button";
  activateAll.className = "sync-btn";
  const activateSelected = document.createElement("button");
  activateSelected.type = "button";
  activateSelected.className = "sync-btn sync-btn--secondary";
  actions.append(activateAll, activateSelected);
  const links = document.createElement("div");
  links.className = "offer-done-actions";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "tool-link-btn";
  done.textContent = "Done";
  const view = document.createElement("a");
  view.className = "tool-link-btn";
  view.href = "https://nextcard.com/dashboard/offers";
  view.target = "_blank";
  view.rel = "noopener noreferrer";
  view.textContent = "View offers →";
  links.append(done, view);
  body.append(status, notice, signIn, progress, cancel, reviewHost, actions, links);

  const modal = document.createElement("div");
  modal.className = "consent-modal-backdrop";
  modal.setAttribute("aria-hidden", "true");
  const dialog = document.createElement("div");
  dialog.className = "consent-modal offer-confirm-modal";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "bofaConfirmTitle");
  dialog.setAttribute("aria-describedby", "bofaConfirmBody");
  const title = document.createElement("div");
  title.id = "bofaConfirmTitle";
  title.className = "auth-title";
  const confirmation = document.createElement("p");
  confirmation.id = "bofaConfirmBody";
  confirmation.className = "offer-confirm-body";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "auth-sign-in-btn consent-btn";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "consent-cancel-btn";
  dismiss.textContent = "Not now";
  dialog.append(title, confirmation, confirm, dismiss);
  modal.append(dialog);
  root.replaceChildren(icon, info, check, body, modal);

  let state: z.infer<typeof bofaPortalStateSchema> | null = null;
  let expanded = false;
  let actionPending = false;
  let actionError: string | null = null;
  let activationTotal = 0;
  let pendingLabel = "Opening Bank of America deals…";
  let pending: {
    runId: string;
    ids: string[];
    trigger: HTMLButtonElement;
  } | null = null;

  function reviewCard(): OfferOperationCard {
    const offers = (state?.offers ?? []).filter((o) => o.action === "activate");
    return {
      key: "bofa-portal",
      name: "Bank of America",
      lastDigits: null,
      availableCount: offers.length,
      countStatus: "complete",
      offers: offers.map((o) => ({
        id: o.issuerOfferId,
        name: o.merchantName,
        value: o.offerValue,
        details: o.detailsText,
        terms: o.termsText,
      })),
    };
  }
  function closeConfirmation() {
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
    pending?.trigger.focus();
    pending = null;
  }
  function render() {
    body.hidden = !expanded;
    root.classList.toggle("guided-active-issuer", expanded);
    document
      .getElementById("toolsTabPanel")
      ?.classList.toggle("bofa-operation-open", expanded);
    const running =
      state?.phase === "checking" || state?.phase === "activating";
    const needsSignIn =
      /session expired|session is unavailable|sign in to BofA|open.*deals.*portal|In BofA, open/i.test(
        actionError ?? state?.error ?? "",
      );
    signIn.hidden = !needsSignIn || running || actionPending;
    const ready = !needsSignIn && state?.phase === "ready" && !actionPending;
    const card = reviewCard();
    const count = card.offers?.length ?? 0;
    const selected = state ? review.selected(state.runId, card).length : 0;
    description.textContent = state?.offers.length
      ? `${state.offers.length.toLocaleString()} offers ${state.saveStatus === "saved" ? "synced" : "found"}`
      : running || actionPending
        ? "Checking offers…"
        : "Not checked · Check for offers";
    check.textContent =
      running || actionPending ? "Working" : state ? "Refresh" : "Check";
    check.disabled = running || actionPending;
    const current = state?.phase === "activating" ? state.added : state?.checked || state?.discovered || 0;
    const progressTotal = state?.phase === "activating" ? activationTotal : state?.total;
    status.textContent = actionPending
      ? pendingLabel
      : needsSignIn
        ? "Sign in to continue checking your offers."
      : state?.phase === "checking"
        ? state.checked
          ? `Reading ${current.toLocaleString()} of ${state.total.toLocaleString()} offers…`
          : `Finding offers${current ? ` · ${current.toLocaleString()} found` : ""}…`
        : state?.phase === "activating"
          ? activationTotal ? `Activating offers · ${state.added} of ${activationTotal} activated` : `Activating offers · ${state.added} activated`
          : state?.phase === "completed"
            ? `${state.added} offer${state.added === 1 ? "" : "s"} activated`
            : state?.phase === "failed" ? "The check couldn't finish. Refresh to try again."
          : state?.phase === "cancelled" ? "Check stopped. Refresh to continue."
          : count
              ? `${count} offer${count === 1 ? "" : "s"} available to activate`
              : state?.offers.length
                ? "You're up to date. Your offers are in nextcard."
                : "Find and activate your Bank of America offers.";
    notice.textContent =
      actionError ??
      (state?.saveStatus === "queued_for_retry"
        ? "Some offers are waiting to sync. Refresh to retry."
        : state?.failed && state.phase === "ready"
          ? `${state.failed} offers couldn't be checked. Refresh to retry.`
          : state?.error) ??
      "";
    if (needsSignIn)
      notice.textContent = "We'll open BofA. After you sign in, we'll continue to your offers and resume the check.";
    notice.hidden = !notice.textContent || actionPending;
    progress.hidden = !running && !actionPending;
    progress.setAttribute("aria-label", status.textContent);
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", String(progressTotal || 100));
    if (progressTotal) {
      progress.setAttribute("aria-valuenow", String(current));
      fill.style.width = `${Math.min(100, (current / progressTotal) * 100)}%`;
    } else {
      progress.removeAttribute("aria-valuenow");
      fill.style.width = "35%";
    }
    cancel.hidden = !running;
    cancel.textContent =
      state?.phase === "activating" ? "Stop after current offer" : "Cancel";
    reviewHost.hidden = !ready || !count;
    if (state && ready && count)
      review.render(reviewHost, state.runId, card, render);
    actions.hidden = !ready || !count;
    activateAll.textContent = `Activate all ${count} offer${count === 1 ? "" : "s"}`;
    activateAll.disabled = !ready || !count;
    activateSelected.textContent = `Activate ${selected} selected offer${selected === 1 ? "" : "s"}`;
    activateSelected.hidden = !selected;
    activateSelected.disabled = !ready || !selected;
    links.hidden = running || actionPending;
    view.hidden = !state?.offers.length;
    if (pending && (pending.runId !== state?.runId || state.phase !== "ready"))
      closeConfirmation();
  }
  async function send(message: object) {
    const raw: unknown = await chrome.runtime.sendMessage(message);
    const response = responseSchema.safeParse(raw);
    if (!response.success)
      throw new Error(
        "BofA did not return its status. Reload nextcard sync and check again.",
      );
    return response.data;
  }
  function apply(next: z.infer<typeof bofaPortalStateSchema> | null) {
    if (next && next.runId !== state?.runId) expanded = true;
    state = next;
    render();
  }
  async function action(message: object) {
    expanded = true;
    actionError = null;
    actionPending = true;
    pendingLabel = "type" in message && message.type === "BOFA_PORTAL_ACTIVATE"
      ? "Activating your offers…"
      : "type" in message && message.type === "BOFA_PORTAL_SIGN_IN"
        ? "Sign in on the BofA tab. Waiting for your offers…"
        : "Opening Bank of America deals…";
    render();
    try {
      const result = await send(message);
      if (result.ok) apply(result.state);
      else
        actionError = result.error ?? "Could not check Bank of America offers.";
    } catch (error) {
      actionError =
        error instanceof Error
          ? error.message
          : "Could not contact the extension.";
    } finally {
      actionPending = false;
      render();
    }
  }
  function showConfirmation(all: boolean) {
    if (state?.phase !== "ready") return;
    const card = reviewCard();
    const ids = all
      ? (card.offers?.map((o) => o.id) ?? [])
      : review.selected(state.runId, card);
    if (!ids.length) return;
    pending = {
      runId: state.runId,
      ids,
      trigger: all ? activateAll : activateSelected,
    };
    title.textContent = `Activate ${ids.length} offer${ids.length === 1 ? "" : "s"}?`;
    confirmation.textContent = `Activate ${all ? "all " : ""}${ids.length} ${all ? "available" : "selected"} Bank of America offer${ids.length === 1 ? "" : "s"}. Offers that are already active or don't require activation won't be changed.`;
    confirm.textContent = `Activate ${ids.length} offer${ids.length === 1 ? "" : "s"}`;
    modal.classList.add("visible");
    modal.setAttribute("aria-hidden", "false");
    confirm.focus();
  }
  signIn.onclick = () => {
    void action({ type: "BOFA_PORTAL_SIGN_IN" });
  };
  check.onclick = () => {
    void action({ type: "BOFA_PORTAL_CHECK" });
  };
  document
    .getElementById("bofaOffersStartBtn")
    ?.addEventListener("click", () => check.click());
  cancel.onclick = () => {
    void action({ type: "BOFA_PORTAL_CANCEL" });
  };
  activateAll.onclick = () => showConfirmation(true);
  activateSelected.onclick = () => showConfirmation(false);
  dismiss.onclick = closeConfirmation;
  confirm.onclick = () => {
    const request = pending;
    closeConfirmation();
    if (request) {
      activationTotal = request.ids.length;
      void action({
        type: "BOFA_PORTAL_ACTIVATE",
        runId: request.runId,
        ids: request.ids,
      });
    }
  };
  done.onclick = () => {
    expanded = false;
    render();
  };
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConfirmation();
    }
    if (event.key === "Tab") {
      event.preventDefault();
      (document.activeElement === confirm ? dismiss : confirm).focus();
    }
  });
  render();
  async function poll() {
    if (actionPending) return;
    try {
      const result = await send({ type: "BOFA_PORTAL_STATUS" });
      if (result.ok && !actionPending) apply(result.state);
    } catch {
      /* The worker may restart between polls. */
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
