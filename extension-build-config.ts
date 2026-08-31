export const NEXTCARD_URL = "https://nextcard.com";
export const CONVEX_SITE_URL = "https://laudable-turtle-546.convex.site";

export function getExtensionDefines(mode: string) {
  return {
    __NEXTCARD_URL__: JSON.stringify(NEXTCARD_URL),
    __CONVEX_SITE_URL__: JSON.stringify(CONVEX_SITE_URL),
    __OFFERS_FIRST_UI_DEV_OVERRIDE__: JSON.stringify(mode === "development"),
    __MOCK_FREE_PLAN__: JSON.stringify(mode === "development"),
    __REWARDS_GUIDE_QA_PREVIEW__: JSON.stringify(
      process.env.REWARDS_GUIDE_QA_PREVIEW === "1",
    ),
    __SAFARI__: JSON.stringify(mode === "safari"),
  };
}
