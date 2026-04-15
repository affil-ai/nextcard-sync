import type { ProviderId } from "../lib/types";

export type ProviderGroup = "Hotels" | "Airlines" | "Banks";

export type ProviderSyncStrategy =
  | "generic"
  | "atmos"
  | "chase-v1"
  | "amex"
  | "capitalone"
  | "hyatt"
  | "bilt";

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  description: string;
  group: ProviderGroup;
  iconPath: string;
  syncStrategy: ProviderSyncStrategy;
  syncUrl: string;
  tabUrlPattern: string;
  accountUrlPattern: string;
  accountUrl?: string;
  magicLinkLogin?: boolean;
  allowedUrlPatterns?: string[];
  extraHostPermissions?: string[];
  manifestMatches: string[];
  contentScriptPath: string;
  benefitsMatches?: string[];
  benefitsContentScriptPath?: string;
}

// Centralize provider metadata so new providers stop touching popup, worker, and tests separately.
export const providerRegistry = {
  marriott: {
    id: "marriott",
    name: "Marriott Bonvoy",
    description: "Hotel loyalty points, elite status & nights",
    group: "Hotels",
    iconPath: "src/icons/marriott-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.marriott.com/loyalty/myAccount/activity.mi",
    tabUrlPattern: "https://www.marriott.com/*",
    accountUrlPattern: "https://www.marriott.com/loyalty/myAccount/activity*",
    manifestMatches: ["https://www.marriott.com/*"],
    contentScriptPath: "src/content-scripts/marriott.ts",
  },
  atmos: {
    id: "atmos",
    name: "Alaska Atmos",
    description: "Airline miles, status & segments",
    group: "Airlines",
    iconPath: "src/icons/atmos-36.png",
    syncStrategy: "atmos",
    syncUrl: "https://www.alaskaair.com/atmosrewards/account/overview/?lid=AS_Nav_Account_Profile",
    tabUrlPattern: "https://www.alaskaair.com/*",
    accountUrlPattern: "https://www.alaskaair.com/atmosrewards/*",
    manifestMatches: ["https://www.alaskaair.com/*"],
    contentScriptPath: "src/content-scripts/atmos.ts",
  },
  chase: {
    id: "chase",
    name: "Chase",
    description: "Credit card points & benefit credits",
    group: "Banks",
    iconPath: "src/icons/chase-36.png",
    syncStrategy: "chase-v1",
    syncUrl: "https://secure.chase.com/web/auth/dashboard#/dashboard/overview",
    tabUrlPattern: "https://*.chase.com/*",
    accountUrlPattern: "https://secure.chase.com/web/auth/dashboard*",
    manifestMatches: ["https://ultimaterewardspoints.chase.com/*"],
    contentScriptPath: "src/content-scripts/chase.ts",
    benefitsMatches: ["https://secure.chase.com/*"],
    benefitsContentScriptPath: "src/content-scripts/chase-benefits.ts",
  },
  aa: {
    id: "aa",
    name: "American Airlines AAdvantage",
    description: "Airline miles & elite status",
    group: "Airlines",
    iconPath: "src/icons/aa-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.aa.com/aadvantage-program/profile/account-summary",
    tabUrlPattern: "https://www.aa.com/*",
    accountUrlPattern: "https://www.aa.com/aadvantage-program/*",
    allowedUrlPatterns: ["https://login.aa.com/*"],
    manifestMatches: ["https://www.aa.com/*", "https://login.aa.com/*"],
    contentScriptPath: "src/content-scripts/aa.ts",
  },
  delta: {
    id: "delta",
    name: "Delta SkyMiles",
    description: "Airline miles & Medallion status",
    group: "Airlines",
    iconPath: "src/icons/delta-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.delta.com/myskymiles/overview",
    tabUrlPattern: "https://www.delta.com/*",
    accountUrlPattern: "https://www.delta.com/myskymiles/*",
    manifestMatches: ["https://www.delta.com/*"],
    contentScriptPath: "src/content-scripts/delta.ts",
  },
  united: {
    id: "united",
    name: "United MileagePlus",
    description: "Airline miles & Premier status",
    group: "Airlines",
    iconPath: "src/icons/united-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.united.com/en/us/united-mileageplus-signin/",
    tabUrlPattern: "https://www.united.com/*",
    accountUrlPattern: "https://www.united.com/*/myunited*",
    accountUrl: "https://www.united.com/en/us/myunited",
    manifestMatches: ["https://www.united.com/*"],
    contentScriptPath: "src/content-scripts/united.ts",
  },
  southwest: {
    id: "southwest",
    name: "Southwest Rapid Rewards",
    description: "Airline points, credits & A-List progress",
    group: "Airlines",
    iconPath: "src/icons/southwest-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.southwest.com/loyalty/myaccount/",
    tabUrlPattern: "https://www.southwest.com/*",
    accountUrlPattern: "https://www.southwest.com/loyalty/myaccount/*",
    accountUrl: "https://www.southwest.com/loyalty/myaccount/",
    manifestMatches: ["https://www.southwest.com/*"],
    contentScriptPath: "src/content-scripts/southwest.ts",
  },
  ihg: {
    id: "ihg",
    name: "IHG One Rewards",
    description: "Hotel points, elite status & nights",
    group: "Hotels",
    iconPath: "src/icons/ihg-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.ihg.com/rewardsclub/us/en/account-mgmt/home",
    tabUrlPattern: "https://www.ihg.com/*",
    accountUrlPattern: "https://www.ihg.com/rewardsclub/us/en/account-mgmt/*",
    accountUrl: "https://www.ihg.com/rewardsclub/us/en/account-mgmt/home",
    manifestMatches: ["https://www.ihg.com/*"],
    contentScriptPath: "src/content-scripts/ihg.ts",
  },
  hyatt: {
    id: "hyatt",
    name: "World of Hyatt",
    description: "Hotel points, elite status & nights",
    group: "Hotels",
    iconPath: "src/icons/hyatt-36.png",
    syncStrategy: "hyatt",
    syncUrl: "https://www.hyatt.com/en-US/member/sign-in",
    tabUrlPattern: "https://www.hyatt.com/*",
    accountUrlPattern: "https://www.hyatt.com/profile/*/account-overview*",
    accountUrl: "https://www.hyatt.com/profile/en-US/account-overview",
    magicLinkLogin: true,
    manifestMatches: ["https://www.hyatt.com/*"],
    contentScriptPath: "src/content-scripts/hyatt.ts",
  },
  amex: {
    id: "amex",
    name: "American Express",
    description: "Credit card points & benefit credits",
    group: "Banks",
    iconPath: "src/icons/amex-36.png",
    syncStrategy: "amex",
    syncUrl: "https://global.americanexpress.com/card-benefits/view-all",
    tabUrlPattern: "https://global.americanexpress.com/*",
    accountUrlPattern: "https://global.americanexpress.com/*",
    accountUrl: "https://global.americanexpress.com/card-benefits/view-all",
    allowedUrlPatterns: [
      "https://www.americanexpress.com/*",
      "https://americanexpress.com/*",
    ],
    manifestMatches: [
      "https://global.americanexpress.com/*",
      "https://www.americanexpress.com/*",
      "https://americanexpress.com/*",
    ],
    contentScriptPath: "src/content-scripts/amex.ts",
    benefitsMatches: ["https://global.americanexpress.com/*"],
    benefitsContentScriptPath: "src/content-scripts/amex-offers.ts",
  },
  capitalone: {
    id: "capitalone",
    name: "Capital One",
    description: "Credit card miles & benefit credits",
    group: "Banks",
    iconPath: "src/icons/capitalone-36.png",
    syncStrategy: "capitalone",
    syncUrl: "https://myaccounts.capitalone.com/accountSummary",
    tabUrlPattern: "https://myaccounts.capitalone.com/*",
    accountUrlPattern: "https://myaccounts.capitalone.com/*",
    accountUrl: "https://myaccounts.capitalone.com/accountSummary",
    allowedUrlPatterns: [
      "https://verified.capitalone.com/*",
      "https://travel.capitalone.com/*",
    ],
    manifestMatches: [
      "https://myaccounts.capitalone.com/*",
      "https://verified.capitalone.com/*",
      "https://travel.capitalone.com/*",
    ],
    contentScriptPath: "src/content-scripts/capitalone.ts",
  },
  hilton: {
    id: "hilton",
    name: "Hilton Honors",
    description: "Hotel points, elite status & nights",
    group: "Hotels",
    iconPath: "src/icons/hilton-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.hilton.com/en/hilton-honors/guest/my-account/",
    tabUrlPattern: "https://www.hilton.com/*",
    accountUrlPattern: "https://www.hilton.com/*/hilton-honors/guest/*",
    accountUrl: "https://www.hilton.com/en/hilton-honors/guest/my-account/",
    manifestMatches: ["https://www.hilton.com/*"],
    contentScriptPath: "src/content-scripts/hilton.ts",
  },
  frontier: {
    id: "frontier",
    name: "Frontier Miles",
    description: "Airline miles and profile balance",
    group: "Airlines",
    iconPath: "src/icons/frontier-36.png",
    syncStrategy: "generic",
    syncUrl: "https://booking.flyfrontier.com/FrontierMiles/Profile",
    tabUrlPattern: "https://booking.flyfrontier.com/*",
    accountUrlPattern: "https://booking.flyfrontier.com/FrontierMiles/*",
    accountUrl: "https://booking.flyfrontier.com/FrontierMiles/Profile",
    manifestMatches: ["https://booking.flyfrontier.com/*"],
    contentScriptPath: "src/content-scripts/frontier.ts",
  },
  bilt: {
    id: "bilt",
    name: "Bilt Rewards",
    description: "Points, elite status & rent rewards",
    group: "Banks",
    iconPath: "src/icons/bilt-36.png",
    syncStrategy: "bilt",
    syncUrl: "https://www.bilt.com/wallet",
    tabUrlPattern: "https://www.bilt.com/*",
    accountUrlPattern: "https://www.bilt.com/wallet*",
    accountUrl: "https://www.bilt.com/wallet",
    manifestMatches: ["https://www.bilt.com/*"],
    extraHostPermissions: ["https://www.biltrewards.com/*"],
    contentScriptPath: "src/content-scripts/bilt.ts",
  },
  discover: {
    id: "discover",
    name: "Discover",
    description: "Credit card cashback balance",
    group: "Banks",
    iconPath: "src/icons/discover-36.png",
    syncStrategy: "generic",
    syncUrl: "https://portal.discover.com/customersvcs/universalLogin/ac_main",
    tabUrlPattern: "https://*.discover.com/*",
    accountUrlPattern: "https://card.discover.com/web/achome/*",
    accountUrl: "https://card.discover.com/web/achome/homepage",
    manifestMatches: ["https://card.discover.com/*", "https://portal.discover.com/*", "https://www.discover.com/*"],
    contentScriptPath: "src/content-scripts/discover.ts",
  },
  citi: {
    id: "citi",
    name: "Citi",
    description: "Credit card points & miles",
    group: "Banks",
    iconPath: "src/icons/citi-36.png",
    syncStrategy: "generic",
    syncUrl: "https://www.citi.com/login",
    tabUrlPattern: "https://*.citi.com/*",
    accountUrlPattern: "https://online.citi.com/US/ag/dashboard.*",
    accountUrl: "https://online.citi.com/US/ag/dashboard/summary",
    manifestMatches: ["https://online.citi.com/*", "https://www.citi.com/*"],
    contentScriptPath: "src/content-scripts/citi.ts",
  },
} satisfies Record<ProviderId, ProviderDefinition>;

export function getProviderIconUrl(providerId: ProviderId) {
  return chrome.runtime.getURL(providerRegistry[providerId].iconPath);
}

export const providerIds = Object.keys(providerRegistry) as ProviderId[];

export function getProviderHostPermissions(definition: ProviderDefinition) {
  return Array.from(
    new Set([
      definition.tabUrlPattern,
      ...definition.manifestMatches,
      ...(definition.benefitsMatches ?? []),
      ...(definition.allowedUrlPatterns ?? []),
      ...(definition.extraHostPermissions ?? []),
    ]),
  );
}

export function buildProviderContentScripts() {
  const scripts = providerIds.flatMap((providerId) => {
    const definition: ProviderDefinition = providerRegistry[providerId];
    const entries = [
      {
        matches: definition.manifestMatches,
        js: [definition.contentScriptPath],
        run_at: "document_idle" as const,
      },
    ];

    if (definition.benefitsMatches && definition.benefitsContentScriptPath) {
      entries.push({
        matches: definition.benefitsMatches,
        js: [definition.benefitsContentScriptPath],
        run_at: "document_idle" as const,
      });
    }

    return entries;
  });

  // Tool content scripts (offer management, not sync)
  scripts.push({
    matches: ["https://global.americanexpress.com/*", "https://www.americanexpress.com/*"],
    js: ["src/content-scripts/amex-offers.ts"],
    run_at: "document_idle" as const,
  });
  scripts.push({
    matches: ["https://secure.chase.com/*", "https://secure01a.chase.com/*", "https://secure03a.chase.com/*", "https://secure05a.chase.com/*", "https://secure07a.chase.com/*"],
    js: ["src/content-scripts/chase-offers.ts"],
    run_at: "document_idle" as const,
  });
  scripts.push({
    matches: ["https://online.citi.com/*", "https://www.citi.com/*"],
    js: ["src/content-scripts/citi-offers.ts"],
    run_at: "document_idle" as const,
  });
  scripts.push({
    matches: ["https://card.discover.com/*", "https://www.discover.com/*"],
    js: ["src/content-scripts/discover-bonus.ts"],
    run_at: "document_idle" as const,
  });

  return scripts;
}
