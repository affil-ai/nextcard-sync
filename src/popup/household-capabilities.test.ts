import { describe, expect, it } from "vitest";
import type { HouseholdExtensionContext } from "../lib/household-context";
import { getHouseholdSyncAvailability } from "./household-capabilities";

const context: HouseholdExtensionContext = {
  protocolVersion: 2,
  minimumExtensionVersion: "0.8.1",
  recommendedExtensionVersion: "0.8.1",
  accountScopeId: "household:one",
  contextRevision: "revision-1",
  primaryMemberId: "primary",
  householdActivated: true,
  capabilities: {
    householdReads: true,
    householdWrites: true,
    loyaltyReads: true,
    loyaltyWrites: false,
    memberIssuerCardSync: true,
    memberOfferReads: true,
    memberOfferWrites: false,
    combinedReads: true,
  },
  members: [
    { id: "primary", displayName: "Vishal", isPrimary: true, lifecycleVersion: 1 },
    { id: "member", displayName: "Test", isPrimary: false, lifecycleVersion: 1 },
  ],
};

describe("household popup capability policy", () => {
  it("keeps issuer writes independent from loyalty writes", () => {
    expect(getHouseholdSyncAvailability(context, "member")).toMatchObject({
      loyaltyWrites: false,
      issuerWrites: true,
    });
  });

  it("keeps offer reads available while offer writes are paused", () => {
    expect(getHouseholdSyncAvailability(context, "member")).toMatchObject({
      offerReads: true,
      offerWrites: false,
    });
  });

  it("preserves Primary compatibility when member capabilities are paused", () => {
    expect(getHouseholdSyncAvailability(context, "primary")).toMatchObject({
      loyaltyWrites: true,
      issuerWrites: true,
      offerReads: true,
      offerWrites: true,
    });
  });

  it("fully resets controls outside a multi-member household", () => {
    expect(getHouseholdSyncAvailability({
      ...context,
      householdActivated: false,
      capabilities: {
        ...context.capabilities,
        householdReads: false,
      },
      members: [],
    }, null)).toEqual({
      householdVisible: false,
      loyaltyWrites: true,
      issuerWrites: true,
      offerReads: true,
      offerWrites: true,
    });
  });
});
