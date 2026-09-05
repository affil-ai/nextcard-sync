import type { HouseholdExtensionContext } from "../lib/household-context";

export interface HouseholdSyncAvailability {
  householdVisible: boolean;
  loyaltyWrites: boolean;
  issuerWrites: boolean;
  offerReads: boolean;
  offerWrites: boolean;
}

export function getHouseholdSyncAvailability(
  context: HouseholdExtensionContext,
  selectedMemberId: string | null,
): HouseholdSyncAvailability {
  const householdVisible = context.capabilities.householdReads
    && (context.members.length >= 2 || (context.householdActivated && selectedMemberId === null));
  if (!householdVisible) {
    return {
      householdVisible: false,
      loyaltyWrites: true,
      issuerWrites: true,
      offerReads: true,
      offerWrites: true,
    };
  }

  const selected = context.members.find(
    (member) => member.id === selectedMemberId,
  );
  if (!selected) return { householdVisible: true, loyaltyWrites: false, issuerWrites: false, offerReads: false, offerWrites: false };
  const usesPrimaryCompatibility = selected.isPrimary;
  return {
    householdVisible: true,
    loyaltyWrites:
      usesPrimaryCompatibility || context.capabilities.loyaltyWrites,
    issuerWrites:
      usesPrimaryCompatibility || context.capabilities.memberIssuerCardSync,
    offerReads:
      usesPrimaryCompatibility || context.capabilities.memberOfferReads,
    offerWrites:
      usesPrimaryCompatibility || context.capabilities.memberOfferWrites,
  };
}
