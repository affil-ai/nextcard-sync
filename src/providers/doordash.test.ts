import { describe, expect, it } from "vitest";
import { normalizeDoorDashReads, type DoorDashRead } from "./doordash";

function placement(source: string, title: string, description: string, id = "campaign", tags = "CHASE_MONTHLY_BENEFIT_CAMPAIGN"): DoorDashRead {
  return { source, status: "ok", data: { getPlacements: { placements: { placementSections: [{ placementModels: [{
    title: { copy: title }, description: { copy: description },
    custom: { campaign_id: id }, logging: { campaign_tags: tags },
  }] }] } } } };
}
describe("DoorDash campaign observations", () => {
  it("merges wallet and checkout observations without interpreting allowance as remaining uses", () => {
    const result = normalizeDoorDashReads([
      placement("placements:wallet", "$10 off Chase monthly benefit", "Apply at checkout"),
      placement("placements:checkout:1", "$10 off grocery and retail", "2 per month"),
      placement("placements:checkout:2", "$10 off grocery and retail", "2 per month"),
      placement("placements:checkout:1", "$15 off any eligible order", "1 per month", "other"),
    ], "2026-10-16T12:00:00Z", null);
    expect(result.campaigns).toHaveLength(2);
    expect(result.campaigns[0]).toMatchObject({ title: "$10 off grocery and retail", frequency: "monthly", allowance: 2, remainingUses: null, availability: "offered" });
    expect(result.campaigns[0]?.sources).toHaveLength(3);
    expect(result.campaigns[1]).toMatchObject({ allowance: 1, remainingUses: null });
  });
  it("uses explicit quarterly promo copy even when the internal tag says monthly", () => {
    const result = normalizeDoorDashReads([placement("placements:wallet", "$10 off Chase quarterly promo", "1 per quarter")], "now", null);
    expect(result.campaigns[0]).toMatchObject({ frequency: "quarterly", allowance: 1, remainingUses: null });
  });
  it("keeps subscription billing separate from benefit frequency", () => {
    const result = normalizeDoorDashReads([
      { source: "membership", status: "ok", data: { subscriptionInformation: { subscriptionInfo: {
        subscriptionPlan: { id: "plan", recurrenceIntervalType: "year" },
        manageSubscriptionDashboard: { sectionsList: [{ name: "subscription_state", descriptionList: ["Chase subscription", "Enrollment date: 10/13/26"] }] },
      } } } },
      placement("placements:wallet", "$10 Chase monthly benefit", "Apply at checkout"),
    ], "now", null);
    expect(result.billingInterval).toBe("year");
    expect(result.campaigns[0]?.frequency).toBe("monthly");
    expect(result.membership).toEqual(["Chase subscription"]);
  });
  it("does not mark empty or failed placements as used", () => {
    const result = normalizeDoorDashReads([
      { source: "subscription", status: "ok", data: { plan_id: "plan", is_eligible_for_benefits: true, subscription_status: "ACTIVE" } },
      { source: "placements:wallet", status: "ok", data: { getPlacements: { placements: { placementSections: [] } } } },
      { source: "placements:checkout:1", status: "error", error: "HTTP 403" },
    ], "now", null);
    expect(result.campaigns).toEqual([]);
    expect(result.checkoutContextsChecked).toBe(0);
    expect(result.checks[2]?.status).toBe("error");
  });
  it("ignores unrelated discounts and excludes raw account/payment/cart data from exports", () => {
    const result = normalizeDoorDashReads([
      placement("placements:wallet", "$5 off your order", "Welcome", "welcome", "WELCOME"),
      { source: "subscription", status: "ok", data: { plan_id: "plan", consumer_subscription_id: "private-id", payment: "private-card" } },
      { source: "carts", status: "ok", data: { address: "private-address" } },
    ], "now", "fingerprint");
    expect(result.campaigns).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("does not guess unknown allowances", () => {
    const result = normalizeDoorDashReads([placement("placements:wallet", "$10 off Chase benefit", "Apply at checkout", "campaign", "CHASE_BENEFIT")], "now", null);
    expect(result.campaigns[0]).toMatchObject({ allowance: null, frequency: "unknown" });
  });
});
