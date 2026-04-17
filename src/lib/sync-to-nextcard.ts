/**
 * Pushes scraped loyalty data from the extension to the NextCard backend.
 *
 * Flow: extension → HTTP POST to Convex httpAction → upsert userLoyaltyAccounts
 *
 * The transform layer here maps bespoke scraper output (provider-specific field names)
 * into standardized shapes before pushing:
 *   - Loyalty programs (airlines/hotels) → StandardizedLoyaltyData
 *   - Credit card issuers (Chase/Amex/CapitalOne) → StandardizedIssuerData
 */

import type { ProviderId, MarriottLoyaltyData, AtmosLoyaltyData, ChaseURData, AALoyaltyData, DeltaLoyaltyData, UnitedLoyaltyData, SouthwestLoyaltyData, IHGLoyaltyData, HyattLoyaltyData, AmexLoyaltyData, CapitalOneLoyaltyData, HiltonLoyaltyData, FrontierLoyaltyData, BiltLoyaltyData, DiscoverLoyaltyData, CitiLoyaltyData } from "./types";
import {
  atmosProviderDataSchema,
  chaseProviderDataSchema,
  marriottProviderDataSchema,
  aaProviderDataSchema,
  deltaProviderDataSchema,
  unitedProviderDataSchema,
  southwestProviderDataSchema,
  ihgProviderDataSchema,
  hyattProviderDataSchema,
  amexProviderDataSchema,
  capitalOneProviderDataSchema,
  hiltonProviderDataSchema,
  frontierProviderDataSchema,
  biltProviderDataSchema,
  discoverProviderDataSchema,
  citiProviderDataSchema,
} from "../contracts/loyalty-provider-data";
import type { StandardizedLoyaltyData, StandardizedIssuerData, QualifyingMetric, Stat } from "../contracts/loyalty-provider-data";
import { getAuth } from "./auth";

function maskId(value: string | null | undefined): string | null {
  if (!value || value.length <= 4) return value ?? null;
  return "*".repeat(value.length - 4) + value.slice(-4);
}

const SENSITIVE_KEYS = new Set(["memberNumber", "memberName"]);

function maskSensitiveFields<T>(obj: T): T {
  if (obj === null || obj === undefined || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitiveFields) as T;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key) && typeof value === "string") {
      result[key] = maskId(value);
    } else if (typeof value === "object" && value !== null) {
      result[key] = maskSensitiveFields(value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/** Maps extension provider IDs to Convex loyaltyPrograms slugs */
const PROVIDER_TO_SLUG: Record<ProviderId, string> = {
  marriott: "marriott-bonvoy",
  atmos: "alaska-mileage-plan",
  chase: "chase",
  aa: "american-aadvantage",
  delta: "delta-skymiles",
  united: "united-mileageplus",
  southwest: "southwest-rapid-rewards",
  ihg: "ihg-one-rewards",
  hyatt: "world-of-hyatt",
  amex: "amex",
  capitalone: "capital-one",
  hilton: "hilton-honors",
  frontier: "frontier-miles",
  bilt: "bilt-rewards",
  discover: "discover",
  citi: "citi",
};

const ISSUER_PROVIDERS = new Set<ProviderId>(["chase", "amex", "capitalone", "discover", "citi"]);

export type AnyProviderData = MarriottLoyaltyData | AtmosLoyaltyData | ChaseURData | AALoyaltyData | DeltaLoyaltyData | UnitedLoyaltyData | SouthwestLoyaltyData | IHGLoyaltyData | HyattLoyaltyData | AmexLoyaltyData | CapitalOneLoyaltyData | HiltonLoyaltyData | FrontierLoyaltyData | BiltLoyaltyData | DiscoverLoyaltyData | CitiLoyaltyData;

export type ProviderDataValidationResult =
  | { ok: true; data: AnyProviderData }
  | { ok: false; error: string };

export function validateProviderData(
  provider: ProviderId,
  data: unknown
): ProviderDataValidationResult {
  const schemas: Record<string, { safeParse: (data: unknown) => { success: boolean; data?: unknown } }> = {
    marriott: marriottProviderDataSchema,
    chase: chaseProviderDataSchema,
    aa: aaProviderDataSchema,
    delta: deltaProviderDataSchema,
    united: unitedProviderDataSchema,
    southwest: southwestProviderDataSchema,
    ihg: ihgProviderDataSchema,
    hyatt: hyattProviderDataSchema,
    amex: amexProviderDataSchema,
    capitalone: capitalOneProviderDataSchema,
    atmos: atmosProviderDataSchema,
    hilton: hiltonProviderDataSchema,
    frontier: frontierProviderDataSchema,
    bilt: biltProviderDataSchema,
    discover: discoverProviderDataSchema,
    citi: citiProviderDataSchema,
  };

  const schema = schemas[provider];
  if (!schema) {
    return { ok: false, error: `Unknown provider: ${provider}` };
  }

  const result = schema.safeParse(data);
  if (!result.success) {
    return { ok: false, error: `Invalid ${provider} provider data` };
  }

  return { ok: true, data: result.data as AnyProviderData };
}

// ── Transform to standardized shapes ──────────────────────────

function formatNumber(n: number | null | undefined): string {
  if (n == null) return "0";
  return new Intl.NumberFormat("en-US").format(n);
}

function toStandardizedLoyaltyData(provider: ProviderId, data: AnyProviderData): StandardizedLoyaltyData {
  if (provider === "marriott") {
    const d = data as MarriottLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.eliteNightsCurrentYear != null) {
      const target = d.nextTierTarget ? parseInt(d.nextTierTarget.replace(/[^0-9]/g, ""), 10) : null;
      metrics.push({ label: "Elite Nights", current: d.eliteNightsCurrentYear, target: Number.isNaN(target) ? null : target, unit: "nights" });
    }
    const stats: Stat[] = [];
    if (d.eliteNightsLifetime != null) stats.push({ label: "Lifetime Nights", value: formatNumber(d.eliteNightsLifetime) });
    if (d.nightsStayed != null) stats.push({ label: "Nights Stayed", value: formatNumber(d.nightsStayed) });
    if (d.totalQualifiedSpend) stats.push({ label: "Qualified Spend", value: d.totalQualifiedSpend });
    if (d.certificates?.length > 0) stats.push({ label: "Certificates", value: String(d.certificates.length) });
    if (d.pointsExpirationDate) stats.push({ label: "Points Expiration", value: d.pointsExpirationDate });

    return {
      pointsBalance: d.pointsBalance,
      pointsLabel: "Points",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "atmos") {
    const d = data as AtmosLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.statusPoints != null) {
      metrics.push({ label: "Status Points", current: d.statusPoints, target: null, unit: "points" });
    }
    const stats: Stat[] = [];
    if (d.rewards?.length > 0) stats.push({ label: "Rewards", value: String(d.rewards.length) });
    if (d.discounts?.length > 0) stats.push({ label: "Discounts", value: String(d.discounts.length) });

    return {
      pointsBalance: d.availablePoints,
      pointsLabel: "Miles",
      statusLevel: d.statusLevel,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "aa") {
    const d = data as AALoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.loyaltyPoints != null) {
      // loyaltyPointsToNextTier is the *remaining* points (e.g. "5,634 more to reach Gold"),
      // not the total threshold. Compute the actual target as current + remaining.
      const remaining = d.loyaltyPointsToNextTier ? parseInt(d.loyaltyPointsToNextTier.replace(/[^0-9]/g, ""), 10) : null;
      const target = remaining != null && !Number.isNaN(remaining) ? d.loyaltyPoints + remaining : null;
      metrics.push({ label: "Loyalty Points", current: d.loyaltyPoints, target, unit: "points" });
    }
    const stats: Stat[] = [];
    if (d.millionMilerMiles != null) stats.push({ label: "Million Miler Miles", value: formatNumber(d.millionMilerMiles) });
    if (d.prevYearLoyaltyPoints) stats.push({ label: "Prev Year LP", value: d.prevYearLoyaltyPoints });

    return {
      pointsBalance: d.milesBalance,
      pointsLabel: "Miles",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "delta") {
    const d = data as DeltaLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.mqds != null) {
      const target = d.mqdsToNextTier ? parseInt(d.mqdsToNextTier.replace(/[^0-9]/g, ""), 10) : null;
      metrics.push({ label: "MQDs", current: d.mqds, target: Number.isNaN(target) ? null : target, unit: "$" });
    }
    const stats: Stat[] = [];
    if (d.lifetimeMiles != null) stats.push({ label: "Lifetime Miles", value: formatNumber(d.lifetimeMiles) });
    if (d.memberSince) stats.push({ label: "Member Since", value: d.memberSince });
    if (d.deltaAmexCard) stats.push({ label: "Delta Amex Card", value: d.deltaAmexCard });

    return {
      pointsBalance: d.milesBalance,
      pointsLabel: "Miles",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "united") {
    const d = data as UnitedLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.pqps != null) metrics.push({ label: "PQPs", current: d.pqps, target: null, unit: "$" });
    if (d.pqfs != null) metrics.push({ label: "PQFs", current: d.pqfs, target: null, unit: "flights" });
    const stats: Stat[] = [];
    if (d.lifetimeMiles != null) stats.push({ label: "Lifetime Miles", value: formatNumber(d.lifetimeMiles) });
    if (d.travelBankBalance) stats.push({ label: "Travel Bank", value: d.travelBankBalance });

    return {
      pointsBalance: d.milesBalance,
      pointsLabel: "Miles",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "southwest") {
    const d = data as SouthwestLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.aListFlights != null || d.aListFlightsTarget != null) {
      metrics.push({
        label: "A-List Flights",
        current: d.aListFlights,
        target: d.aListFlightsTarget,
        unit: "flights",
      });
    }
    if (d.aListPoints != null || d.aListPointsTarget != null) {
      metrics.push({
        label: "A-List Points",
        current: d.aListPoints,
        target: d.aListPointsTarget,
        unit: "points",
      });
    }
    if (d.companionFlights != null || d.companionFlightsTarget != null) {
      metrics.push({
        label: "Companion Pass Flights",
        current: d.companionFlights,
        target: d.companionFlightsTarget,
        unit: "flights",
      });
    }
    if (d.companionPoints != null || d.companionPointsTarget != null) {
      metrics.push({
        label: "Companion Pass Points",
        current: d.companionPoints,
        target: d.companionPointsTarget,
        unit: "points",
      });
    }
    const stats: Stat[] = [];
    if (d.availableCreditsDollars) stats.push({ label: "Available Credits", value: d.availableCreditsDollars });
    if (d.flightCreditsSummary) stats.push({ label: "Flight Credits", value: d.flightCreditsSummary });
    if (d.memberSince) stats.push({ label: "Member Since", value: d.memberSince });

    return {
      pointsBalance: d.pointsBalance,
      pointsLabel: "Points",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "hilton") {
    const d = data as HiltonLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.nightsThisYear != null) {
      metrics.push({ label: "Nights This Year", current: d.nightsThisYear, target: d.nightsToNextTier, unit: "nights" });
    }
    const stats: Stat[] = [];
    if (d.lifetimeNights != null) stats.push({ label: "Lifetime Nights", value: formatNumber(d.lifetimeNights) });
    if (d.nextTierName) stats.push({ label: "Next Tier", value: d.nextTierName });
    if (d.memberSince) stats.push({ label: "Member Since", value: d.memberSince });

    return {
      pointsBalance: d.pointsBalance,
      pointsLabel: "Points",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "ihg") {
    const d = data as IHGLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.qualifyingNights != null || d.nightsToNextTier != null) {
      const target = d.qualifyingNights != null && d.nightsToNextTier != null
        ? d.qualifyingNights + d.nightsToNextTier
        : null;
      metrics.push({
        label: "Qualifying Nights",
        current: d.qualifyingNights,
        target,
        unit: "nights",
      });
    }
    const stats: Stat[] = [];
    if (d.nextTierName) stats.push({ label: "Next Tier", value: d.nextTierName });
    if (d.milestoneNightsToNext != null) stats.push({ label: "Nights To Next Milestone", value: formatNumber(d.milestoneNightsToNext) });
    if (d.nextMilestoneRewardAt != null) stats.push({ label: "Next Reward At", value: `${formatNumber(d.nextMilestoneRewardAt)} nights` });

    return {
      pointsBalance: d.pointsBalance,
      pointsLabel: "Points",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "frontier") {
    const d = data as FrontierLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.eliteStatusPoints != null || d.nextEliteStatusTarget != null) {
      metrics.push({
        label: "Elite Status Points",
        current: d.eliteStatusPoints,
        target: d.nextEliteStatusTarget,
        unit: "points",
      });
    }
    const stats: Stat[] = [];
    if (d.statusExpiration) stats.push({ label: "Status Expiration", value: d.statusExpiration });
    if (d.nextEliteStatus) stats.push({ label: "Next Tier", value: d.nextEliteStatus });
    if (d.pointsToNextEliteStatus != null) stats.push({ label: "Points To Next Tier", value: formatNumber(d.pointsToNextEliteStatus) });

    return {
      pointsBalance: d.milesBalance,
      pointsLabel: "Miles",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  if (provider === "bilt") {
    const d = data as BiltLoyaltyData;
    const metrics: QualifyingMetric[] = [];
    if (d.pointsProgress != null && d.pointsTarget != null) {
      metrics.push({ label: "Points Progress", current: d.pointsProgress, target: d.pointsTarget, unit: "points" });
    }
    const stats: Stat[] = [];
    if (d.statusValidThrough) stats.push({ label: "Status Valid Through", value: d.statusValidThrough });
    if (d.spendProgress && d.spendTarget) stats.push({ label: "Eligible Spend", value: `${d.spendProgress} of ${d.spendTarget}` });
    if (d.primaryCardName) stats.push({ label: "Primary Card", value: d.primaryCardName });
    if (d.linkedCardsCount != null) stats.push({ label: "Linked Cards", value: formatNumber(d.linkedCardsCount) });
    if (d.availableCreditsCount != null) stats.push({ label: "Available Credits", value: formatNumber(d.availableCreditsCount) });
    if (d.biltCashBalance != null) stats.push({ label: "Bilt Cash Balance", value: `$${d.biltCashBalance.toFixed(2)}` });
    if (d.biltCashExpiration) stats.push({ label: "Bilt Cash Expires", value: d.biltCashExpiration });
    if (d.walletCredits.length > 0) stats.push({ label: "Wallet Credit Types", value: d.walletCredits.map((credit) => credit.name).join(", ") });
    if (d.pointsToNextBiltCashReward != null && d.nextBiltCashRewardAmount != null) {
      stats.push({
        label: "Next Bilt Cash Reward",
        value: `${formatNumber(d.pointsToNextBiltCashReward)} points to $${d.nextBiltCashRewardAmount.toFixed(2)}`,
      });
    }
    return {
      pointsBalance: d.pointsBalance,
      pointsLabel: "Points",
      statusLevel: d.eliteStatus,
      memberName: d.memberName,
      memberNumber: d.memberNumber,
      qualifyingMetrics: metrics,
      stats,
      raw: d,
    };
  }

  // hyatt (fallthrough)
  const d = data as HyattLoyaltyData;
  const metrics: QualifyingMetric[] = [];
  if (d.qualifyingNights != null) metrics.push({ label: "Qualifying Nights", current: d.qualifyingNights, target: null, unit: "nights" });
  if (d.milestoneProgress != null && d.milestoneTotal != null) {
    metrics.push({ label: "Milestone Progress", current: d.milestoneProgress, target: d.milestoneTotal, unit: null });
  }
  const stats: Stat[] = [];
  if (d.basePoints != null) stats.push({ label: "Base Points", value: formatNumber(d.basePoints) });
  if (d.milestoneNights != null) stats.push({ label: "Milestone Nights", value: String(d.milestoneNights) });
  if (d.validatedThrough) stats.push({ label: "Validated Through", value: d.validatedThrough });
  if (d.memberSince) stats.push({ label: "Member Since", value: d.memberSince });

  return {
    pointsBalance: d.pointsBalance,
    pointsLabel: "Points",
    statusLevel: d.eliteStatus,
    memberName: d.memberName,
    memberNumber: d.memberNumber,
    qualifyingMetrics: metrics,
    stats,
    raw: d,
  };
}

function extractLastFourDigits(cardName: string | null): string | null {
  if (!cardName) return null;
  const match = cardName.match(/(\d{4,5})\s*\)?$/);
  return match ? match[1] : null;
}

function toStandardizedIssuerData(provider: ProviderId, data: AnyProviderData): StandardizedIssuerData {
  // Currently scrapers produce single-card data; wrap into cards[] array
  if (provider === "chase") {
    const d = data as ChaseURData & { _allCards?: ChaseURData[] };

    // Multi-card: service worker attaches _allCards when multiple UR accounts were scraped
    if (d._allCards && d._allCards.length > 0) {
      return {
        cards: d._allCards.map((card) => ({
          cardName: card.cardName,
          lastFourDigits: card.lastFourDigits ?? extractLastFourDigits(card.cardName),
          availablePoints: card.availablePoints,
          pendingPoints: card.pendingPoints,
          benefits: card.benefits.map((b) => ({
            name: b.name,
            amountUsed: b.amountUsed,
            totalAmount: b.totalAmount,
            remaining: b.remaining,
            period: b.period,
            activationStatus: b.activationStatus ?? null,
          })),
        })),
      };
    }

    return {
      cards: [{
        cardName: d.cardName,
        lastFourDigits: d.lastFourDigits ?? extractLastFourDigits(d.cardName),
        availablePoints: d.availablePoints,
        pendingPoints: d.pendingPoints,
        benefits: d.benefits.map((b) => ({
          name: b.name,
          amountUsed: b.amountUsed,
          totalAmount: b.totalAmount,
          remaining: b.remaining,
          period: b.period,
          activationStatus: b.activationStatus ?? null,
        })),
      }],
    };
  }

  if (provider === "amex") {
    const d = data as AmexLoyaltyData & { _allCards?: AmexLoyaltyData[] };

    // Multi-card: service worker attaches _allCards when multiple cards were scraped
    if (d._allCards && d._allCards.length > 0) {
      return {
        cards: d._allCards.map((card) => ({
          cardName: card.cardName,
          lastFourDigits: extractLastFourDigits(card.cardName),
          availablePoints: card.availablePoints,
          pendingPoints: card.pendingPoints,
          benefits: card.benefits.map((b) => ({
            name: b.name,
            amountUsed: b.amountUsed,
            totalAmount: b.totalAmount,
            remaining: b.remaining,
            period: b.period,
          })),
        })),
      };
    }

    return {
      cards: [{
        cardName: d.cardName,
        lastFourDigits: extractLastFourDigits(d.cardName),
        availablePoints: d.availablePoints,
        pendingPoints: d.pendingPoints,
        benefits: d.benefits.map((b) => ({
          name: b.name,
          amountUsed: b.amountUsed,
          totalAmount: b.totalAmount,
          remaining: b.remaining,
          period: b.period,
        })),
      }],
    };
  }

  if (provider === "citi") {
    const d = data as CitiLoyaltyData;
    return {
      cards: d.cards.map((card) => ({
        cardName: card.cardName,
        lastFourDigits: card.lastFourDigits,
        availablePoints: card.rewardsBalance,
        pendingPoints: null,
        rewardsLabel: card.rewardsLabel,
        benefits: [],
      })),
    };
  }

  if (provider === "discover") {
    const d = data as DiscoverLoyaltyData;
    return {
      cards: [{
        cardName: d.cardName,
        lastFourDigits: d.lastFourDigits,
        availablePoints: d.cashbackBalance,
        pendingPoints: null,
        rewardsLabel: "Cashback",
        benefits: [],
      }],
    };
  }

  // capitalone
  const d = data as CapitalOneLoyaltyData & { _allCards?: CapitalOneLoyaltyData[] };

  // Multi-card: service worker attaches _allCards when multiple cards were found
  if (d._allCards && d._allCards.length > 0) {
    return {
      cards: d._allCards.map((card) => ({
        cardName: card.cardName,
        lastFourDigits: extractLastFourDigits(card.cardName),
        availablePoints: card.availablePoints,
        pendingPoints: card.pendingPoints,
        rewardsLabel: card.rewardsLabel ?? d.rewardsLabel ?? null,
        benefits: card.benefits.map((b) => ({
          name: b.name,
          amountUsed: b.amountUsed,
          totalAmount: b.totalAmount,
          remaining: b.remaining,
          period: b.period,
        })),
      })),
    };
  }

  return {
    cards: [{
      cardName: d.cardName,
      lastFourDigits: extractLastFourDigits(d.cardName),
      availablePoints: d.availablePoints,
      pendingPoints: d.pendingPoints,
      rewardsLabel: d.rewardsLabel ?? null,
      benefits: d.benefits.map((b) => ({
        name: b.name,
        amountUsed: b.amountUsed,
        totalAmount: b.totalAmount,
        remaining: b.remaining,
        period: b.period,
      })),
    }],
  };
}

function toStandardizedProviderData(provider: ProviderId, data: AnyProviderData): StandardizedLoyaltyData | StandardizedIssuerData {
  if (ISSUER_PROVIDERS.has(provider)) {
    return toStandardizedIssuerData(provider, data);
  }
  return toStandardizedLoyaltyData(provider, data);
}

// ── Extract common fields for the top-level upsert columns ────

function extractCommonFields(provider: ProviderId, data: AnyProviderData) {
  if (ISSUER_PROVIDERS.has(provider)) {
    // For issuers, use first card's data for the common columns
    const issuerData = toStandardizedIssuerData(provider, data);
    const firstCard = issuerData.cards[0];
    return {
      pointsBalance: firstCard?.availablePoints ?? null,
      statusLevel: null,
      memberName: firstCard?.cardName ?? null,
      memberNumber: null,
    };
  }

  const loyaltyData = toStandardizedLoyaltyData(provider, data);
  return {
    pointsBalance: loyaltyData.pointsBalance,
    statusLevel: loyaltyData.statusLevel,
    memberName: loyaltyData.memberName,
    memberNumber: loyaltyData.memberNumber,
  };
}

// ── Pull / Push ───────────────────────────────────────────────

export type PulledAccount = {
  provider: ProviderId;
  providerData: AnyProviderData;
  lastSyncedAt: string;
};

export async function pullFromNextCard(): Promise<{ ok: boolean; accounts?: PulledAccount[]; error?: string }> {
  const auth = await getAuth();
  if (!auth) {
    return { ok: false, error: "Not signed in to NextCard" };
  }

  try {
    const response = await fetch(`${__CONVEX_SITE_URL__}/extension/pull`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth.token}` },
    });

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      return { ok: false, error: result.error ?? `HTTP ${response.status}` };
    }

    const data = await response.json();
    return { ok: true, accounts: data.accounts ?? [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function pushToNextCard(
  provider: ProviderId,
  data: AnyProviderData
): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuth();
  if (!auth) {
    return { ok: false, error: "Not signed in to NextCard" };
  }

  const validatedProviderData = validateProviderData(provider, data);

  if (!validatedProviderData.ok) {
    return { ok: false, error: validatedProviderData.error };
  }

  const standardized = toStandardizedProviderData(provider, validatedProviderData.data);
  const common = extractCommonFields(provider, validatedProviderData.data);
  const body = maskSensitiveFields({
    provider,
    loyaltyProgramSlug: PROVIDER_TO_SLUG[provider],
    ...common,
    providerData: standardized,
    rawProviderData: data,
  });

  try {
    const response = await fetch(`${__CONVEX_SITE_URL__}/extension/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      return { ok: false, error: result.error ?? `HTTP ${response.status}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}

export async function deleteFromNextCard(provider: ProviderId): Promise<{ ok: boolean; error?: string }> {
  const auth = await getAuth();
  if (!auth) return { ok: false, error: "Not signed in" };

  try {
    const response = await fetch(`${__CONVEX_SITE_URL__}/extension/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ provider }),
    });

    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      return { ok: false, error: result.error ?? `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
}
