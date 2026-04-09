import type { ProviderId } from "../lib/types";

function getRequiredElement<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }

  return element as T;
}

export const coreViews = {
  auth: getRequiredElement<HTMLDivElement>("authView"),
  disclosure: getRequiredElement<HTMLDivElement>("disclosureView"),
  home: getRequiredElement<HTMLDivElement>("homeView"),
};

export const providerViews: Record<ProviderId, HTMLDivElement> = {
  marriott: getRequiredElement<HTMLDivElement>("marriottView"),
  atmos: getRequiredElement<HTMLDivElement>("atmosView"),
  chase: getRequiredElement<HTMLDivElement>("chaseView"),
  aa: getRequiredElement<HTMLDivElement>("aaView"),
  delta: getRequiredElement<HTMLDivElement>("deltaView"),
  united: getRequiredElement<HTMLDivElement>("unitedView"),
  southwest: getRequiredElement<HTMLDivElement>("southwestView"),
  ihg: getRequiredElement<HTMLDivElement>("ihgView"),
  hyatt: getRequiredElement<HTMLDivElement>("hyattView"),
  amex: getRequiredElement<HTMLDivElement>("amexView"),
  capitalone: getRequiredElement<HTMLDivElement>("capitaloneView"),
  hilton: getRequiredElement<HTMLDivElement>("hiltonView"),
  frontier: getRequiredElement<HTMLDivElement>("frontierView"),
  bilt: getRequiredElement<HTMLDivElement>("biltView"),
};

export const views = {
  ...coreViews,
  ...providerViews,
};

export const authElements = {
  authSignInBtn: getRequiredElement<HTMLButtonElement>("authSignInBtn"),
  authLogo: getRequiredElement<HTMLImageElement>("authLogo"),
  userAvatar: getRequiredElement<HTMLDivElement>("userAvatar"),
  userName: getRequiredElement<HTMLDivElement>("userName"),
  userEmail: getRequiredElement<HTMLDivElement>("userEmail"),
  userSignOutBtn: getRequiredElement<HTMLButtonElement>("userSignOutBtn"),
  disclosureLogo: getRequiredElement<HTMLImageElement>("disclosureLogo"),
};

export const homeElements = {
  providerList: getRequiredElement<HTMLDivElement>("providerList"),
  onboardingProviders: getRequiredElement<HTMLDivElement>("onboardingProviders"),
  tourTooltip: getRequiredElement<HTMLDivElement>("tourTooltip"),
  congratsBanner: getRequiredElement<HTMLDivElement>("congratsBanner"),
  congratsBtn: getRequiredElement<HTMLButtonElement>("congratsBtn"),
};

export const onboardingElements = {
  onboardingBtn: getRequiredElement<HTMLButtonElement>("onboardingBtn"),
};

export const consentElements = {
  consentModal: getRequiredElement<HTMLDivElement>("consentModal"),
  consentCheckbox: getRequiredElement<HTMLInputElement>("consentCheckbox"),
  consentContinueBtn: getRequiredElement<HTMLButtonElement>("consentContinueBtn"),
};

export const footerElements = {
  versionFooter: getRequiredElement<HTMLDivElement>("versionFooter"),
  changelog: getRequiredElement<HTMLDivElement>("changelog"),
};
