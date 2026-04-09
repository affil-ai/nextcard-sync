import { describe, expect, it } from "vitest";
import {
  extractAllChaseAccountMetadata,
  extractChaseAccountMetadata,
  extractChaseApiBenefits,
  isChaseAccountMetadata,
  mapChaseBenefitsFromApi,
} from "./chase-benefits-api-helpers";

describe("chase benefits api helpers", () => {
  it("extracts the current card metadata from Chase app bootstrap data", () => {
    const appData = {
      cache: [
        {
          url: "/svc/rr/accounts/secure/v4/dashboard/tiles/list",
          response: {
            defaultAccountId: 1168106067,
            accountTiles: [
              {
                accountId: 1168106067,
                accountOriginationCode: "6530",
                rewardProgramCode: "0444",
                rewardsTypeId: "VW-6530-0444",
                tileDetail: {
                  productCode: "VW",
                },
              },
              {
                accountId: 987654321,
                accountOriginationCode: "6530",
                rewardProgramCode: "0443",
                rewardsTypeId: "VY-6530-0443",
                tileDetail: {
                  productCode: "VY",
                },
              },
            ],
          },
        },
      ],
    };

    const metadata = extractChaseAccountMetadata(appData, "1168106067");

    expect(metadata).toEqual({
      digitalAccountIdentifier: 1168106067,
      accountOrganizationCode: "6530",
      accountProductCode: "VW",
      rewardsProductCode: "0444",
    });

    expect(extractAllChaseAccountMetadata(appData)).toEqual([
      {
        digitalAccountIdentifier: 1168106067,
        accountOrganizationCode: "6530",
        accountProductCode: "VW",
        rewardsProductCode: "0444",
      },
      {
        digitalAccountIdentifier: 987654321,
        accountOrganizationCode: "6530",
        accountProductCode: "VY",
        rewardsProductCode: "0443",
      },
    ]);
  });

  it("maps Chase benefit list responses into extension benefit rows", () => {
    const apiBenefits = extractChaseApiBenefits({
      benefitsList: [
        {
          benefits: [
            {
              benefitIdentifier: "VXvGrGaV",
              benefitName: "$50 annual Chase Travel hotel credit*",
              benefitTypeCode: "Statement_Credit",
              benefitStatusTypeCode: "StatusNotShown",
              benefitTagIdentifier: "MaximizeStatementCredits",
              benefitUseIndicator: false,
              offers: [
                {
                  offerCreditAmount: 0,
                  benefitOfferAmount: 50,
                  remainingCreditAmount: 50,
                  nextEligibleStatementCreditDate: "2026-07-06",
                  rewardsAnniversaryDate: "2026-07-06",
                  goodTillDate: null,
                },
              ],
              enrollmentInformation: null,
            },
            {
              benefitIdentifier: "NIKk7LH2",
              benefitName: "Complimentary DashPass Membership*",
              benefitTypeCode: "Partner_Enrollment",
              benefitStatusTypeCode: "Activated",
              benefitTagIdentifier: "EnjoyMembershipPerks",
              benefitUseIndicator: true,
              offers: [],
              enrollmentInformation: {
                enrollmentStatusCode: "ENROLLED",
                expirationDate: "2027-12-31",
              },
            },
            {
              benefitIdentifier: "2FuWbJS2",
              benefitName: "DoorDash non-restaurant promo",
              benefitTypeCode: "Static",
              benefitStatusTypeCode: "Activated",
              benefitTagIdentifier: "EnjoyMembershipPerks",
              benefitUseIndicator: true,
              offers: [],
              enrollmentInformation: null,
            },
            {
              benefitIdentifier: "ignore-me",
              benefitName: "5x points on dining",
              benefitTypeCode: "Accelerator",
              benefitStatusTypeCode: "NotApplicable",
              benefitTagIdentifier: "BoostYourPoints",
              benefitUseIndicator: false,
              offers: [],
              enrollmentInformation: null,
            },
          ],
        },
      ],
    });

    expect(mapChaseBenefitsFromApi(apiBenefits)).toEqual([
      {
        name: "$50 annual Chase Travel hotel credit*",
        amountUsed: 0,
        totalAmount: 50,
        remaining: 50,
        period: "Good through 7/6/2026",
        activationStatus: null,
      },
      {
        name: "Complimentary DashPass Membership*",
        amountUsed: null,
        totalAmount: null,
        remaining: null,
        period: null,
        activationStatus: "Activated",
      },
      {
        name: "DoorDash non-restaurant promo",
        amountUsed: null,
        totalAmount: null,
        remaining: null,
        period: null,
        activationStatus: "Activated",
      },
    ]);
  });

  it("accepts only complete Chase account metadata objects", () => {
    expect(isChaseAccountMetadata({
      digitalAccountIdentifier: 1168106067,
      accountOrganizationCode: "6530",
      accountProductCode: "VW",
      rewardsProductCode: "0444",
    })).toBe(true);

    expect(isChaseAccountMetadata({
      digitalAccountIdentifier: 1168106067,
      accountOrganizationCode: "6530",
      rewardsProductCode: "0444",
    })).toBe(false);
  });
});
