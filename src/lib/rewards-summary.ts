import type { ExtensionRewardsSummary, ProviderId } from "./types";

export const REWARDS_SUMMARIES_STORAGE_KEY =
  "nextcard_rewards_summaries_v1";

const PROVIDER_IDS = new Set<ProviderId>([
  "marriott",
  "atmos",
  "chase",
  "aa",
  "delta",
  "united",
  "southwest",
  "ihg",
  "hyatt",
  "amex",
  "capitalone",
  "hilton",
  "frontier",
  "bilt",
  "discover",
  "citi",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.has(value as ProviderId);
}

function readNonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function normalizeDashboardPath(value: unknown, programSlug: string) {
  if (
    typeof value === "string"
    && value.startsWith("/dashboard/rewards")
  ) {
    return value;
  }

  return `/dashboard/rewards?program=${encodeURIComponent(programSlug)}`;
}

function normalizeIconUrl(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value, "https://nextcard.com");
    return url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export function normalizeRewardsSummary(
  value: unknown,
): ExtensionRewardsSummary | null {
  if (
    !isRecord(value)
    || !isProviderId(value.provider)
    || typeof value.loyaltyAccountId !== "string"
    || typeof value.rewardsProgramId !== "string"
    || typeof value.programSlug !== "string"
    || typeof value.programName !== "string"
    || typeof value.lastSyncedAt !== "string"
    || !Number.isFinite(Date.parse(value.lastSyncedAt))
  ) {
    return null;
  }

  const cardCount = readNonNegativeNumber(value.cardCount);
  const benefitCount = readNonNegativeNumber(value.benefitCount);
  if (cardCount === null || benefitCount === null) {
    return null;
  }

  return {
    provider: value.provider,
    loyaltyAccountId: value.loyaltyAccountId,
    rewardsProgramId: value.rewardsProgramId,
    programSlug: value.programSlug,
    programName: value.programName,
    iconUrl: normalizeIconUrl(value.iconUrl),
    pointsBalance:
      typeof value.pointsBalance === "number"
      && Number.isFinite(value.pointsBalance)
        ? value.pointsBalance
        : null,
    statusLevel:
      typeof value.statusLevel === "string" && value.statusLevel.trim()
        ? value.statusLevel.trim()
        : null,
    cardCount,
    benefitCount,
    lastSyncedAt: value.lastSyncedAt,
    dashboardPath: normalizeDashboardPath(
      value.dashboardPath,
      value.programSlug,
    ),
  };
}

export function normalizeRewardsSummaries(
  value: unknown,
): ExtensionRewardsSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const summaries = value
    .map(normalizeRewardsSummary)
    .filter((summary): summary is ExtensionRewardsSummary => summary !== null);
  const unique = new Map(
    summaries.map((summary) => [summary.loyaltyAccountId, summary]),
  );

  return Array.from(unique.values()).sort((left, right) =>
    left.programName.localeCompare(right.programName),
  );
}

export function getRewardsSummaryMeta(
  summary: ExtensionRewardsSummary,
) {
  const parts: string[] = [];
  if (summary.cardCount > 0) {
    parts.push(
      `${summary.cardCount} ${summary.cardCount === 1 ? "card" : "cards"}`,
    );
    if (summary.benefitCount > 0) {
      parts.push(
        `${summary.benefitCount} ${
          summary.benefitCount === 1 ? "benefit" : "benefits"
        }`,
      );
    }
  }
  return parts.join(" · ");
}

export function formatRewardsSummaryBalance(
  summary: ExtensionRewardsSummary,
) {
  if (summary.pointsBalance === null) {
    return null;
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(summary.pointsBalance);
}
