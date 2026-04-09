import { z } from "zod";

// Keep a local copy of the sync contract so the extension can ship independently of the monorepo.
export const marriottCertificateSchema = z.object({
  type: z.string(),
  description: z.string(),
  expiryDate: z.string().nullable(),
  propertyCategory: z.string().nullable()
}).passthrough();

export const marriottProviderDataSchema = z.object({
  pointsBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  eliteNightsCurrentYear: z.number().nullable(),
  eliteNightsLifetime: z.number().nullable(),
  nightsStayed: z.number().nullable(),
  bonusNights: z.number().nullable(),
  totalQualifiedSpend: z.string().nullable(),
  nextTierTarget: z.string().nullable(),
  yearsAsSilverPlus: z.number().nullable(),
  yearsAsGoldPlus: z.number().nullable(),
  yearsAsPlatinum: z.number().nullable(),
  certificates: z.array(marriottCertificateSchema),
  memberNumber: z.string().nullable(),
  memberName: z.string().nullable(),
  pointsExpirationDate: z.string().nullable()
}).passthrough();

export const atmosRewardCardSchema = z.object({
  title: z.string(),
  associatedCard: z.string().nullable(),
  useBy: z.string().nullable()
}).passthrough();

export const atmosDiscountSchema = z.object({
  name: z.string(),
  code: z.string().nullable(),
  expiration: z.string().nullable(),
  details: z.string().nullable()
}).passthrough();

export const atmosProviderDataSchema = z.object({
  availablePoints: z.number().nullable(),
  statusPoints: z.number().nullable(),
  statusLevel: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  rewards: z.array(atmosRewardCardSchema),
  discounts: z.array(atmosDiscountSchema)
}).passthrough();

export const chaseBenefitSchema = z.object({
  name: z.string(),
  amountUsed: z.number().nullable(),
  totalAmount: z.number().nullable(),
  remaining: z.number().nullable(),
  period: z.string().nullable(),
  activationStatus: z.string().nullable().optional(),
}).passthrough();

export const chaseProviderDataSchema = z.object({
  cardName: z.string().nullable(),
  lastFourDigits: z.string().nullable(),
  availablePoints: z.number().nullable(),
  pendingPoints: z.number().nullable(),
  benefits: z.array(chaseBenefitSchema)
}).passthrough();

export const aaProviderDataSchema = z.object({
  milesBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  loyaltyPoints: z.number().nullable(),
  loyaltyPointsToNextTier: z.string().nullable(),
  prevYearLoyaltyPoints: z.string().nullable(),
  millionMilerMiles: z.number().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
}).passthrough();

export const deltaProviderDataSchema = z.object({
  milesBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  memberSince: z.string().nullable(),
  mqds: z.number().nullable(),
  mqdsToNextTier: z.string().nullable(),
  lifetimeMiles: z.number().nullable(),
  deltaAmexCard: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
}).passthrough();

export const unitedProviderDataSchema = z.object({
  milesBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  pqps: z.number().nullable(),
  pqfs: z.number().nullable(),
  lifetimeMiles: z.number().nullable(),
  travelBankBalance: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
}).passthrough();

export const hyattMilestoneChoiceSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
});

export const hyattProviderDataSchema = z.object({
  pointsBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  qualifyingNights: z.number().nullable(),
  basePoints: z.number().nullable(),
  memberSince: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  validatedThrough: z.string().nullable(),
  milestoneNights: z.number().nullable(),
  milestoneProgress: z.number().nullable(),
  milestoneTotal: z.number().nullable(),
  milestoneChoices: z.array(hyattMilestoneChoiceSchema).default([]),
  awards: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    expiryDate: z.string().nullable(),
  })).default([]),
}).passthrough();

export const amexBenefitSchema = z.object({
  name: z.string(),
  amountUsed: z.number().nullable(),
  totalAmount: z.number().nullable(),
  remaining: z.number().nullable(),
  period: z.string().nullable(),
}).passthrough();

export const amexProviderDataSchema = z.object({
  cardName: z.string().nullable(),
  availablePoints: z.number().nullable(),
  pendingPoints: z.number().nullable(),
  benefits: z.array(amexBenefitSchema),
}).passthrough();

export const capitalOneBenefitSchema = z.object({
  name: z.string(),
  amountUsed: z.number().nullable(),
  totalAmount: z.number().nullable(),
  remaining: z.number().nullable(),
  period: z.string().nullable(),
}).passthrough();

export const capitalOneProviderDataSchema = z.object({
  cardName: z.string().nullable(),
  availablePoints: z.number().nullable(),
  pendingPoints: z.number().nullable(),
  rewardsLabel: z.string().nullable().optional(),
  benefits: z.array(capitalOneBenefitSchema),
}).passthrough();

export const hiltonProviderDataSchema = z.object({
  pointsBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  nightsThisYear: z.number().nullable(),
  nightsToNextTier: z.number().nullable(),
  staysThisYear: z.number().nullable(),
  staysToNextTier: z.number().nullable(),
  spendThisYear: z.string().nullable(),
  spendToNextTier: z.string().nullable(),
  nextTierName: z.string().nullable(),
  lifetimeNights: z.number().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  memberSince: z.string().nullable(),
}).passthrough();

export const frontierProviderDataSchema = z.object({
  milesBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  eliteStatusPoints: z.number().nullable(),
  statusExpiration: z.string().nullable(),
  nextEliteStatus: z.string().nullable(),
  nextEliteStatusTarget: z.number().nullable(),
  pointsToNextEliteStatus: z.number().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
}).passthrough();

export const southwestProviderDataSchema = z.object({
  pointsBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  memberSince: z.string().nullable(),
  availableCreditsDollars: z.string().nullable(),
  flightCreditsSummary: z.string().nullable(),
  aListFlights: z.number().nullable(),
  aListFlightsTarget: z.number().nullable(),
  aListPoints: z.number().nullable(),
  aListPointsTarget: z.number().nullable(),
  companionFlights: z.number().nullable(),
  companionFlightsTarget: z.number().nullable(),
  companionPoints: z.number().nullable(),
  companionPointsTarget: z.number().nullable(),
}).passthrough();

export const ihgProviderDataSchema = z.object({
  pointsBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  qualifyingNights: z.number().nullable(),
  nightsToNextTier: z.number().nullable(),
  nextTierName: z.string().nullable(),
  milestoneNightsToNext: z.number().nullable(),
  nextMilestoneRewardAt: z.number().nullable(),
}).passthrough();

export type MarriottProviderData = z.infer<typeof marriottProviderDataSchema>;
export type AtmosProviderData = z.infer<typeof atmosProviderDataSchema>;
export type ChaseProviderData = z.infer<typeof chaseProviderDataSchema>;
export type AAProviderData = z.infer<typeof aaProviderDataSchema>;
export type DeltaProviderData = z.infer<typeof deltaProviderDataSchema>;
export type UnitedProviderData = z.infer<typeof unitedProviderDataSchema>;
export type IHGProviderData = z.infer<typeof ihgProviderDataSchema>;
export type HyattProviderData = z.infer<typeof hyattProviderDataSchema>;
export type AmexProviderData = z.infer<typeof amexProviderDataSchema>;
export type CapitalOneProviderData = z.infer<typeof capitalOneProviderDataSchema>;
export type HiltonProviderData = z.infer<typeof hiltonProviderDataSchema>;
export type FrontierProviderData = z.infer<typeof frontierProviderDataSchema>;
export type SouthwestProviderData = z.infer<typeof southwestProviderDataSchema>;

export const biltProviderDataSchema = z.object({
  pointsBalance: z.number().nullable(),
  eliteStatus: z.string().nullable(),
  statusValidThrough: z.string().nullable(),
  pointsProgress: z.number().nullable(),
  pointsTarget: z.number().nullable(),
  spendProgress: z.string().nullable(),
  spendTarget: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  primaryCardName: z.string().nullable(),
  linkedCardsCount: z.number().nullable(),
  availableCreditsCount: z.number().nullable(),
  biltCashBalance: z.number().nullable(),
  biltCashExpiration: z.string().nullable(),
  pointsToNextBiltCashReward: z.number().nullable(),
  nextBiltCashRewardAmount: z.number().nullable(),
  walletCredits: z.array(z.object({
    name: z.string(),
    amount: z.number().nullable(),
    expiresAt: z.string().nullable(),
    actionLabel: z.string().nullable(),
  })).default([]),
  linkedCards: z.array(z.object({
    cardName: z.string(),
    lastFourDigits: z.string().nullable(),
  })).default([]),
}).passthrough();

export type BiltProviderData = z.infer<typeof biltProviderDataSchema>;

export const qualifyingMetricSchema = z.object({
  label: z.string(),
  current: z.number().nullable(),
  target: z.number().nullable(),
  unit: z.string().nullable(),
});

export const statSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const standardizedLoyaltyDataSchema = z.object({
  pointsBalance: z.number().nullable(),
  pointsLabel: z.string().nullable(),
  statusLevel: z.string().nullable(),
  memberName: z.string().nullable(),
  memberNumber: z.string().nullable(),
  qualifyingMetrics: z.array(qualifyingMetricSchema).default([]),
  stats: z.array(statSchema).default([]),
  raw: z.any().optional(),
});

export const cardBenefitDataSchema = z.object({
  name: z.string(),
  amountUsed: z.number().nullable(),
  totalAmount: z.number().nullable(),
  remaining: z.number().nullable(),
  period: z.string().nullable(),
  activationStatus: z.string().nullable().optional(),
});

export const cardDataSchema = z.object({
  cardName: z.string().nullable(),
  lastFourDigits: z.string().nullable(),
  availablePoints: z.number().nullable(),
  pendingPoints: z.number().nullable(),
  rewardsLabel: z.string().nullable().optional(),
  benefits: z.array(cardBenefitDataSchema),
});

export const standardizedIssuerDataSchema = z.object({
  cards: z.array(cardDataSchema),
});

export type StandardizedLoyaltyData = z.infer<typeof standardizedLoyaltyDataSchema>;
export type StandardizedIssuerData = z.infer<typeof standardizedIssuerDataSchema>;
export type QualifyingMetric = z.infer<typeof qualifyingMetricSchema>;
export type Stat = z.infer<typeof statSchema>;
export type CardBenefitData = z.infer<typeof cardBenefitDataSchema>;
export type CardData = z.infer<typeof cardDataSchema>;
