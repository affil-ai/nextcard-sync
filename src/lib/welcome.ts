export const WELCOME_PAGE_PATH = "src/welcome/index.html";

export function registerInstallWelcome() {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") return;
    void chrome.tabs.create({
      url: chrome.runtime.getURL(WELCOME_PAGE_PATH),
      active: true,
    }).catch((error: unknown) => {
      console.error("[nextcard] Could not open the setup guide", error);
    });
  });
}
