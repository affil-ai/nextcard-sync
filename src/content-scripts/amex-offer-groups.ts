export interface SharedOfferCard {
  id: string;
  name: string;
  lastDigits: string | null;
}

export interface SharedOffer {
  offerId: string;
  status: string;
}

export interface SharedOfferSnapshot<Offer extends SharedOffer = SharedOffer> {
  complete: boolean;
  offers: Offer[];
}

export interface SharedOfferTarget<Card extends SharedOfferCard, Offer extends SharedOffer> {
  card: Card;
  offer: Offer;
}

export interface SharedOfferGroup<Card extends SharedOfferCard, Offer extends SharedOffer> {
  offerId: string;
  targets: Array<SharedOfferTarget<Card, Offer>>;
}

export function isExplicitlyEligibleAmexOffer(status: string): boolean {
  const normalized = status.trim().toUpperCase();
  return normalized === "ELIGIBLE" || normalized === "NOT_ENROLLED";
}

export function buildSharedOfferGroups<Card extends SharedOfferCard, Offer extends SharedOffer>(
  selectedCardId: string,
  cards: Card[],
  snapshots: ReadonlyMap<string, SharedOfferSnapshot<Offer>>,
): Array<SharedOfferGroup<Card, Offer>> {
  const selectedSnapshot = snapshots.get(selectedCardId);
  if (!selectedSnapshot?.complete) return [];

  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const completeSnapshots = cards
    .map((card) => ({ card, snapshot: snapshots.get(card.id) }))
    .filter((entry): entry is { card: Card; snapshot: SharedOfferSnapshot<Offer> } => Boolean(entry.snapshot?.complete));

  if (completeSnapshots.length !== cards.length) return [];

  return selectedSnapshot.offers.flatMap((selectedOffer) => {
    if (!selectedOffer.offerId || !isExplicitlyEligibleAmexOffer(selectedOffer.status)) return [];

    const targets = completeSnapshots.flatMap(({ card, snapshot }) => {
      const matchingOffer = snapshot.offers.find((offer) => (
        offer.offerId === selectedOffer.offerId
        && isExplicitlyEligibleAmexOffer(offer.status)
      ));
      return matchingOffer ? [{ card: cardsById.get(card.id) ?? card, offer: matchingOffer }] : [];
    });

    return targets.length > 1 ? [{ offerId: selectedOffer.offerId, targets }] : [];
  });
}
