import type { ChaseBenefit } from "../../lib/types";

export interface ChaseAccountMetadata {
  digitalAccountIdentifier: number;
  accountOrganizationCode: string;
  accountProductCode: string;
  rewardsProductCode: string;
}

export interface ChaseBenefitOffer {
  offerCreditAmount: number | null;
  benefitOfferAmount: number | null;
  remainingCreditAmount: number | null;
  nextEligibleStatementCreditDate: string | null;
  rewardsAnniversaryDate: string | null;
  goodTillDate: string | null;
}

export interface ChaseBenefitEnrollment {
  enrollmentStatusCode: string | null;
  expirationDate: string | null;
}

export interface ChaseApiBenefit {
  benefitIdentifier: string;
  benefitName: string;
  benefitTypeCode: string | null;
  benefitStatusTypeCode: string | null;
  benefitTagIdentifier: string | null;
  benefitUseIndicator: boolean | null;
  offers: ChaseBenefitOffer[];
  enrollmentInformation: ChaseBenefitEnrollment | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function getNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" ? value : null;
}

function getBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : null;
}

function getRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function getRecords(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function parseAccountId(accountId: string | null) {
  if (!accountId) return null;
  const parsed = Number.parseInt(accountId, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseAccountProductCode(tile: Record<string, unknown>) {
  const tileDetail = getRecord(tile, "tileDetail");
  const directProductCode = tileDetail ? getString(tileDetail, "productCode") : null;
  if (directProductCode) return directProductCode;

  const rewardsTypeId = getString(tile, "rewardsTypeId");
  if (!rewardsTypeId) return null;

  const [productCode] = rewardsTypeId.split("-");
  return productCode || null;
}

function normalizeStatus(status: string | null) {
  if (!status || status === "NotApplicable" || status === "StatusNotShown") return null;
  return status
    .split("_")
    .map((part) => {
      if (!part) return part;
      return `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function formatChaseDate(date: string | null) {
  if (!date) return null;

  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;

  const [, year, month, day] = match;
  return `${Number.parseInt(month, 10)}/${Number.parseInt(day, 10)}/${year}`;
}

function mapOffer(record: Record<string, unknown>): ChaseBenefitOffer {
  return {
    offerCreditAmount: getNumber(record, "offerCreditAmount"),
    benefitOfferAmount: getNumber(record, "benefitOfferAmount"),
    remainingCreditAmount: getNumber(record, "remainingCreditAmount"),
    nextEligibleStatementCreditDate: getString(record, "nextEligibleStatementCreditDate"),
    rewardsAnniversaryDate: getString(record, "rewardsAnniversaryDate"),
    goodTillDate: getString(record, "goodTillDate"),
  };
}

function mapEnrollment(record: Record<string, unknown>): ChaseBenefitEnrollment {
  return {
    enrollmentStatusCode: getString(record, "enrollmentStatusCode"),
    expirationDate: getString(record, "expirationDate"),
  };
}

function mapBenefit(record: Record<string, unknown>): ChaseApiBenefit {
  const offers = getRecords(record, "offers").map(mapOffer);
  const enrollmentInformationRecord = getRecord(record, "enrollmentInformation");

  return {
    benefitIdentifier: getString(record, "benefitIdentifier") ?? "",
    benefitName: getString(record, "benefitName") ?? "",
    benefitTypeCode: getString(record, "benefitTypeCode"),
    benefitStatusTypeCode: getString(record, "benefitStatusTypeCode"),
    benefitTagIdentifier: getString(record, "benefitTagIdentifier"),
    benefitUseIndicator: getBoolean(record, "benefitUseIndicator"),
    offers,
    enrollmentInformation: enrollmentInformationRecord ? mapEnrollment(enrollmentInformationRecord) : null,
  };
}

function findTrackableOffer(benefit: ChaseApiBenefit) {
  return benefit.offers.find((offer) => {
    return (
      offer.offerCreditAmount != null ||
      offer.benefitOfferAmount != null ||
      offer.remainingCreditAmount != null
    );
  }) ?? null;
}

function deriveActivationStatus(benefit: ChaseApiBenefit) {
  const enrollmentStatus = benefit.enrollmentInformation?.enrollmentStatusCode ?? null;
  if (enrollmentStatus === "ENROLLED" || benefit.benefitUseIndicator === true) {
    return "Activated";
  }

  const normalizedBenefitStatus = normalizeStatus(benefit.benefitStatusTypeCode);
  if (normalizedBenefitStatus) return normalizedBenefitStatus;

  return normalizeStatus(enrollmentStatus);
}

function deriveTrackableFields(benefit: ChaseApiBenefit) {
  const offer = findTrackableOffer(benefit);
  if (!offer) {
    return {
      amountUsed: null,
      totalAmount: null,
      remaining: null,
      period: null,
    };
  }

  const totalAmount = offer.benefitOfferAmount;
  let amountUsed = offer.offerCreditAmount;
  if (amountUsed == null && totalAmount != null && offer.remainingCreditAmount != null) {
    amountUsed = roundCurrency(totalAmount - offer.remainingCreditAmount);
  }

  let remaining = offer.remainingCreditAmount;
  if (remaining == null && totalAmount != null && amountUsed != null) {
    remaining = roundCurrency(totalAmount - amountUsed);
  }

  const periodDate =
    offer.nextEligibleStatementCreditDate ??
    offer.rewardsAnniversaryDate ??
    offer.goodTillDate;

  return {
    amountUsed,
    totalAmount,
    remaining,
    // The API gives us raw dates, so we format them to match the old scraper output.
    period: periodDate ? `Good through ${formatChaseDate(periodDate)}` : null,
  };
}

function shouldIncludeBenefit(benefit: ChaseApiBenefit) {
  if (findTrackableOffer(benefit)) return true;
  if (deriveActivationStatus(benefit)) return true;
  return benefit.benefitTagIdentifier === "EnjoyMembershipPerks";
}

export function extractChaseAccountMetadata(appDataResponse: unknown, accountId: string | null) {
  return (
    extractAllChaseAccountMetadata(appDataResponse).find((metadata) => {
      const targetAccountId = parseAccountId(accountId);
      return targetAccountId != null
        ? metadata.digitalAccountIdentifier === targetAccountId
        : false;
    }) ?? extractAllChaseAccountMetadata(appDataResponse)[0] ?? null
  );
}

export function extractAllChaseAccountMetadata(appDataResponse: unknown) {
  if (!isRecord(appDataResponse)) return [];

  const cacheEntries = getRecords(appDataResponse, "cache");
  const accountTileCache = cacheEntries.find((entry) => {
    const url = getString(entry, "url");
    return url === "/svc/rr/accounts/secure/v4/dashboard/tiles/list";
  });

  if (!accountTileCache) return [];

  const response = getRecord(accountTileCache, "response");
  if (!response) return [];

  return getRecords(response, "accountTiles")
    .map((accountTile) => {
      const digitalAccountIdentifier = getNumber(accountTile, "accountId");
      const accountOrganizationCode = getString(accountTile, "accountOriginationCode");
      const rewardsProductCode = getString(accountTile, "rewardProgramCode");
      const accountProductCode = parseAccountProductCode(accountTile);

      if (
        digitalAccountIdentifier == null ||
        !accountOrganizationCode ||
        !rewardsProductCode ||
        !accountProductCode
      ) {
        return null;
      }

      return {
        digitalAccountIdentifier,
        accountOrganizationCode,
        accountProductCode,
        rewardsProductCode,
      };
    })
    .filter((metadata): metadata is ChaseAccountMetadata => metadata !== null);
}

export function isChaseAccountMetadata(value: unknown): value is ChaseAccountMetadata {
  if (!isRecord(value)) return false;

  return (
    typeof value.digitalAccountIdentifier === "number" &&
    typeof value.accountOrganizationCode === "string" &&
    typeof value.accountProductCode === "string" &&
    typeof value.rewardsProductCode === "string"
  );
}

export function extractChaseApiBenefits(benefitsResponse: unknown) {
  if (!isRecord(benefitsResponse)) return [];

  const lists = getRecords(benefitsResponse, "benefitsList");
  const firstList = lists[0];
  if (!firstList) return [];

  return getRecords(firstList, "benefits").map(mapBenefit);
}

export function mapChaseBenefitsFromApi(benefits: ChaseApiBenefit[]): ChaseBenefit[] {
  return benefits
    .filter(shouldIncludeBenefit)
    .map((benefit) => {
      const trackableFields = deriveTrackableFields(benefit);
      const activationStatus = deriveActivationStatus(benefit);

      return {
        name: benefit.benefitName.trim(),
        amountUsed: trackableFields.amountUsed,
        totalAmount: trackableFields.totalAmount,
        remaining: trackableFields.remaining,
        // Non-trackable perks looked cleaner in the old UI without a synthetic period line.
        period: trackableFields.totalAmount != null ? trackableFields.period : null,
        activationStatus,
      };
    });
}
