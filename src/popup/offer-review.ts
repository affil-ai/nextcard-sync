import type { OfferOperationCard } from "../lib/offer-operation";

/** Keep choices and focus stable while the background snapshot polls. */
export class OfferReview {
  private choices = new Map<string, Set<string>>();
  private rendered = new WeakMap<HTMLElement, string>();

  selected(runId: string, card: OfferOperationCard): string[] {
    return [...(this.choices.get(`${runId}:${card.key}`) ?? [])].filter((id) =>
      card.offers?.some((offer) => offer.id === id),
    );
  }

  render(
    host: HTMLElement,
    runId: string,
    card: OfferOperationCard,
    onChange: () => void,
  ) {
    const key = `${runId}:${card.key}`;
    const fingerprint = JSON.stringify([key, card.offers]);
    if (this.rendered.get(host) === fingerprint) return;
    this.rendered.set(host, fingerprint);
    host.replaceChildren();
    if (!card.offers) {
      host.textContent = "Check again to load the offers before activating.";
      return;
    }
    if (!card.offers.length) return;
    let chosen = this.choices.get(key);
    if (!chosen) {
      chosen = new Set();
      this.choices.set(key, chosen);
    }
    const selected = chosen;
    const controls = document.createElement("div");
    controls.className = "offer-review-controls";
    const instruction = document.createElement("span");
    instruction.textContent = "Select offers to activate";
    const selectAll = document.createElement("button");
    selectAll.type = "button";
    selectAll.className = "tool-link-btn";
    const selectionCount = document.createElement("p");
    selectionCount.className = "offer-review-selection-count";
    selectionCount.setAttribute("aria-live", "polite");
    selectionCount.textContent = `${selected.size} of ${card.offers.length} selected`;
    const inputs: HTMLInputElement[] = [];
    const update = () => {
      selectAll.textContent =
        selected.size === card.offers?.length
          ? "Clear selection"
          : "Select all";
      selectionCount.textContent = `${selected.size} of ${card.offers?.length ?? 0} selected`;
      onChange();
    };
    selectAll.onclick = () => {
      const clear = selected.size === card.offers?.length;
      selected.clear();
      for (const input of inputs) {
        input.checked = !clear;
        if (!clear) selected.add(input.value);
      }
      update();
    };
    controls.append(instruction, selectAll);
    host.append(controls, selectionCount);
    const list = document.createElement("div");
    list.className = "offer-review-list";
    for (const offer of card.offers) {
      const row = document.createElement("div");
      row.className = "offer-review-row";
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = offer.id;
      input.checked = selected.has(offer.id);
      inputs.push(input);
      input.onchange = () => {
        if (input.checked) selected.add(offer.id);
        else selected.delete(offer.id);
        update();
      };
      const copy = document.createElement("span");
      const merchant = document.createElement("strong");
      merchant.textContent = offer.name;
      const value = document.createElement("span");
      value.textContent = offer.value ?? "See issuer terms for offer details.";
      copy.append(merchant, value);
      label.append(input, copy);
      row.append(label);
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Details & terms";
      const text = document.createElement("p");
      text.textContent =
        [offer.details, offer.terms].filter(Boolean).join("\n\n") ||
        "Full terms are available in your issuer’s offer page. Review them before activating.";
      details.append(summary, text);
      row.append(details);
      list.append(row);
    }
    host.append(list);
    selectAll.textContent =
      selected.size === card.offers.length ? "Clear selection" : "Select all";
  }
}
