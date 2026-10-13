/** Public offer details only. Issuer enrollment tokens remain in the content script. */
export interface ReviewOffer {
  id: string;
  name: string;
  value: string | null;
  details: string | null;
  terms: string | null;
}

export function readReviewOffers(value: unknown): ReviewOffer[] | null {
  if (!Array.isArray(value)) return null;
  const offers: ReviewOffer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || !("id" in entry) || !("name" in entry)
      || typeof entry.id !== "string" || !entry.id || typeof entry.name !== "string") return null;
    const text = (value: unknown) => typeof value === "string" ? value.slice(0, 12000) : null;
    offers.push({ id: entry.id, name: entry.name,
      value: "value" in entry ? text(entry.value) : null,
      details: "details" in entry ? text(entry.details) : null,
      terms: "terms" in entry ? text(entry.terms) : null });
  }
  return offers;
}

export function readOfferSelection(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const selection: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(value)) {
    if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && id.length > 0)) return null;
    selection[key] = [...new Set(ids)];
  }
  return selection;
}

/** Fail closed if a chosen offer disappeared. Never substitute another eligible offer. */
export function selectEligibleOffers<T extends { offerId: string }>(offers: T[], ids: string[] | undefined): T[] {
  if (ids === undefined) return offers;
  const chosen = new Set(ids);
  const selected = offers.filter((offer) => chosen.has(offer.offerId));
  if (selected.length !== chosen.size) throw new Error("A selected offer is no longer available. Check offers again.");
  return selected;
}
