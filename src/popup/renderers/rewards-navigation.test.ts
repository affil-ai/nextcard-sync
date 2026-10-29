// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { openRewards } from "./shared";
import { setDisplayedHouseholdScope } from "../state";
import type { HouseholdExtensionContext } from "../../lib/household-context";

afterEach(() => { setDisplayedHouseholdScope(null, null); vi.unstubAllGlobals(); });

it("preserves the selected household member when opening program details", () => {
  const create = vi.fn();
  vi.stubGlobal("chrome", { tabs: { create } });
  const context: HouseholdExtensionContext = {
    protocolVersion: 2, minimumExtensionVersion: "0.8.1", recommendedExtensionVersion: "0.9.3", accountScopeId: "household", contextRevision: "1",
    primaryMemberId: "primary", householdActivated: true,
    capabilities: { householdReads: true, householdWrites: true, loyaltyReads: true, loyaltyWrites: true, memberIssuerCardSync: true, memberOfferReads: true, memberOfferWrites: true, combinedReads: true },
    members: [
      { id: "primary", displayName: "Primary", isPrimary: true, lifecycleVersion: 1 },
      { id: "member-2", displayName: "Mom", isPrimary: false, lifecycleVersion: 1 },
      { id: "member-3", displayName: "Dad", isPrimary: false, lifecycleVersion: 1 },
    ],
  };
  setDisplayedHouseholdScope(context, "member-2");
  openRewards("/dashboard/rewards?program=marriott");
  const memberUrl = new URL(create.mock.calls[0][0].url);
  expect(memberUrl.searchParams.get("member")).toBe("member-2");
  expect(memberUrl.searchParams.get("program")).toBe("marriott");
  setDisplayedHouseholdScope(context, "member-3");
  openRewards("/dashboard/rewards?program=marriott&member=member-2");
  expect(new URL(create.mock.calls[1][0].url).searchParams.get("member")).toBe("member-3");
  setDisplayedHouseholdScope(context, "primary");
  openRewards("/dashboard/rewards?program=marriott&member=member-2");
  expect(new URL(create.mock.calls[2][0].url).searchParams.has("member")).toBe(false);
});
