import type { AmexOffer } from "./amex-offers";

type OfferCopy = Pick<AmexOffer, "detailsText" | "termsText">;
type ContentDependencies = {
  getCachedOfferIds: (offers: AmexOffer[]) => Promise<string[] | null>;
  readDetails: (offer: AmexOffer) => Promise<OfferCopy | null>;
  isActive: () => boolean;
};

function contentKey(offer: AmexOffer) {
  return JSON.stringify([offer.offerId, offer.name, offer.shortDescription, offer.expirationText]);
}

/** The database is the durable cache; this map coalesces cards in the current tab. */
export function createAmexOfferContentLoader() {
  const captured = new Map<string, OfferCopy>();
  const pending = new Map<string, Promise<OfferCopy | null>>();
  return async (offers: AmexOffer[], dependencies: ContentDependencies) => {
    const missing: AmexOffer[] = [];
    for (const offer of offers) {
      const key = contentKey(offer);
      if (offer.termsText?.trim()) captured.set(key, { detailsText: offer.detailsText, termsText: offer.termsText });
      const copy = captured.get(key);
      if (copy) Object.assign(offer, copy);
      else missing.push(offer);
    }
    for (let offset = 0; offset < missing.length && dependencies.isActive(); offset += 100) {
      const batch = missing.slice(offset, offset + 100);
      const cachedIds = await dependencies.getCachedOfferIds(batch).catch(() => null);
      // An unavailable cache is not evidence of a miss. Defer optional enrichment
      // until the next sync instead of flooding Amex during a backend outage.
      if (cachedIds === null || !dependencies.isActive()) continue;
      const known = new Set(cachedIds);
      const needed = batch.filter(offer => !known.has(offer.offerId));
      let next = 0;
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (next < needed.length && dependencies.isActive()) {
          const offer = needed[next++];
          const key = contentKey(offer);
          let copy = captured.get(key);
          if (!copy) {
            let request = pending.get(key);
            if (!request) {
              request = dependencies.readDetails(offer).catch(() => null);
              pending.set(key, request);
            }
            const result = await request;
            pending.delete(key);
            // Descriptions alone and failed detail reads never become cache hits.
            if (result?.termsText?.trim()) {
              copy = { detailsText: result.detailsText, termsText: result.termsText };
              captured.set(key, copy);
            }
          }
          if (copy && dependencies.isActive()) Object.assign(offer, copy);
        }
      }));
    }
  };
}
