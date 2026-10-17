import { z } from "zod";

export const doorDashQueries = {
  membership: `query subscriptionInformation {
    subscriptionInformation { subscriptionInfo {
      subscriptionPlan { id recurrenceIntervalType }
      manageSubscriptionDashboard { sectionsList { name title descriptionList } }
    } }
  }`,
  carts: `query listCarts($input: ListCartsInput!) {
    listCarts(input: $input) { id subtotal creator { id } restaurant { id } }
  }`,
  placements: `query getPlacements($location: PlacementLocation!, $component: PlacementComponent!, $storeId: String, $subtotal: IAmountMonetaryFields) {
    getPlacements(location: $location, component: $component, storeId: $storeId, subtotal: $subtotal, isCardPayment: true) {
      placements { placementSections { placementModels { title { copy } description { copy } custom logging } } }
    }
  }`,
};

export const doorDashReadSchema = z.object({
  source: z.string(),
  status: z.enum(["ok", "error"]),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type DoorDashRead = z.infer<typeof doorDashReadSchema>;

const campaignSchema = z.object({
  campaignId: z.string(),
  title: z.string(),
  descriptions: z.array(z.string()),
  frequency: z.enum(["monthly", "quarterly", "unknown"]),
  allowance: z.number().int().positive().nullable(),
  remainingUses: z.null(),
  availability: z.literal("offered"),
  sources: z.array(z.string()),
});
export const doorDashSnapshotSchema = z.object({
  version: z.literal(1),
  checkedAt: z.string(),
  accountKey: z.string().nullable(),
  planId: z.string().nullable(),
  subscriptionStatus: z.string().nullable(),
  eligibleForBenefits: z.boolean().nullable(),
  activationDate: z.string().nullable(),
  membership: z.array(z.string()),
  billingInterval: z.string().nullable(),
  validationMessages: z.array(z.string()),
  campaigns: z.array(campaignSchema),
  checks: z.array(doorDashReadSchema.omit({ data: true })),
  checkoutContextsChecked: z.number().int().nonnegative(),
});
export type DoorDashSnapshot = z.infer<typeof doorDashSnapshotSchema>;
export const doorDashReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), snapshot: doorDashSnapshotSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function normalizeDoorDashReads(
  reads: DoorDashRead[],
  checkedAt: string,
  accountKey: string | null,
): DoorDashSnapshot {
  const active = record(reads.find((read) => read.source === "subscription" && read.status === "ok")?.data);
  const infoRead = reads.find((read) => read.source === "membership" && read.status === "ok");
  const info = record(record(record(infoRead?.data).subscriptionInformation).subscriptionInfo);
  const plan = record(info.subscriptionPlan);
  const membership = new Set<string>();
  for (const section of list(record(info.manageSubscriptionDashboard).sectionsList)) {
    const row = record(section);
    if (row.name !== "subscription_state") continue;
    for (const description of list(row.descriptionList)) {
      const label = text(description);
      if (label && !/enrollment|expiration|\d{1,2}\/\d{1,2}/i.test(label)) membership.add(label);
    }
  }
  const messages = new Set<string>();
  const campaigns = new Map<string, z.infer<typeof campaignSchema>>();
  for (const read of reads.filter((item) => item.status === "ok")) {
    if (read.source.startsWith("validation:")) {
      const data = record(read.data);
      const type = text(data.consumer_subscription_plan_benefit_membership_type);
      if (type) membership.add(type);
      for (const key of ["message", "checkout_page_error_message", "place_order_page_error_message"]) {
        const message = text(data[key]);
        if (message) messages.add(message);
      }
    }
    if (!read.source.startsWith("placements:")) continue;
    const sections = record(record(record(read.data).getPlacements).placements).placementSections;
    for (const section of list(sections)) {
      for (const value of list(record(section).placementModels)) {
        const model = record(value);
        const custom = record(model.custom);
        const logging = record(model.logging);
        const title = text(record(model.title).copy) ?? "Chase benefit";
        const description = text(record(model.description).copy);
        const tags = text(logging.campaign_tags) ?? "";
        const campaignId = text(custom.campaign_id) ?? text(logging.campaign_id);
        if (!campaignId || !(custom.use_case === "chase" || /chase/i.test(`${title} ${description ?? ""} ${tags} ${text(logging.container) ?? ""}`))) continue;
        const previous = campaigns.get(campaignId);
        const descriptions = [...new Set([...(previous?.descriptions ?? []), ...(description ? [description] : [])])];
        const labels = `${title} ${descriptions.join(" ")} ${tags}`;
        const frequency = /quarter/i.test(labels) ? "quarterly" : /month/i.test(labels) ? "monthly" : previous?.frequency ?? "unknown";
        const allowanceMatch = labels.match(/\b(\d+)\s+(?:times?\s+)?per\s+(?:month|quarter)\b/i);
        campaigns.set(campaignId, {
          campaignId,
          title: previous && !allowanceMatch ? previous.title : title,
          descriptions,
          frequency,
          allowance: allowanceMatch ? Number(allowanceMatch[1]) : previous?.allowance ?? null,
          remainingUses: null,
          availability: "offered",
          sources: [...new Set([...(previous?.sources ?? []), read.source])],
        });
      }
    }
  }
  return {
    version: 1,
    checkedAt,
    accountKey,
    planId: text(active.plan_id) ?? text(plan.id),
    subscriptionStatus: text(active.subscription_status),
    eligibleForBenefits: typeof active.is_eligible_for_benefits === "boolean" ? active.is_eligible_for_benefits : null,
    activationDate: text(active.start_time),
    membership: [...membership],
    billingInterval: text(plan.recurrenceIntervalType),
    validationMessages: [...messages],
    campaigns: [...campaigns.values()],
    checks: reads.map(({ source, status, error }) => ({ source, status, ...(error ? { error } : {}) })),
    checkoutContextsChecked: reads.filter((read) => read.source.startsWith("placements:checkout:") && read.status === "ok").length,
  };
}
