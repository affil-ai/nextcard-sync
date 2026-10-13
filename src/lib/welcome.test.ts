import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInstallWelcome, WELCOME_PAGE_PATH } from "./welcome";

afterEach(() => vi.unstubAllGlobals());

describe("installation welcome", () => {
  it("opens the packaged guide on first install, but not updates or reloads", () => {
    let installed: ((details: chrome.runtime.InstalledDetails) => void) | undefined;
    const createTab = vi.fn().mockResolvedValue({});
    vi.stubGlobal("chrome", {
      runtime: {
        OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update" },
        getURL: (path: string) => `chrome-extension://test/${path}`,
        onInstalled: { addListener: (listener: typeof installed) => { installed = listener; } },
      },
      tabs: { create: createTab },
    });
    registerInstallWelcome();
    expect(installed).toBeDefined();
    installed?.({ reason: chrome.runtime.OnInstalledReason.INSTALL });
    expect(createTab).toHaveBeenCalledWith({
      url: `chrome-extension://test/${WELCOME_PAGE_PATH}`,
      active: true,
    });
    installed?.({ reason: chrome.runtime.OnInstalledReason.UPDATE, previousVersion: "0.8.4" });
    installed?.({ reason: chrome.runtime.OnInstalledReason.CHROME_UPDATE });
    expect(createTab).toHaveBeenCalledTimes(1);
  });
});
