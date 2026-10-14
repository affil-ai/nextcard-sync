import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalMessageRouter } from "./message-router";

function setup(setAuth = vi.fn(async () => {})) {
  const options = {
    nextCardOrigin: "https://nextcard.com",
    setAuth,
    resetAuthCache: vi.fn(),
    hydrateFromNextCard: vi.fn(async () => {}),
    pullOfferUrlCache: vi.fn(async () => {}),
  };
  return { options, router: createExternalMessageRouter(options), reply: vi.fn() };
}
const sender = { url: "https://nextcard.com/extension-auth" };
const message = { type: "AUTH_TOKEN", token: "new-token" };

describe("external sign-in", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockNavigation(guides: Partial<chrome.tabs.Tab>[]) {
    const tabs = {
      query: vi.fn(async () => guides),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      create: vi.fn(async () => ({})),
    };
    const windows = { update: vi.fn(async () => ({})) };
    const welcomeUrl = "chrome-extension://test/src/welcome/index.html";
    vi.stubGlobal("chrome", {
      tabs,
      windows,
      runtime: { getURL: vi.fn(() => welcomeUrl) },
    });
    const authSender = { ...sender, tab: { id: 12, windowId: 4, index: 0, active: true, highlighted: true, pinned: false, incognito: false, selected: true, discarded: false, autoDiscardable: true, groupId: -1 } };
    return { tabs, windows, welcomeUrl, authSender };
  }

  it("returns to the original guide without replacing its document", async () => {
    const { tabs, windows, authSender, welcomeUrl } = mockNavigation([
      { id: 9, windowId: 2 },
      { id: 10, windowId: 4 },
    ]);
    const { router, reply, options } = setup();
    router(message, authSender, reply);
    await vi.waitFor(() => expect(tabs.remove).toHaveBeenCalledWith(12));
    expect(tabs.query).toHaveBeenCalledWith({ url: welcomeUrl });
    expect(tabs.update).toHaveBeenCalledWith(10, { active: true });
    expect(windows.update).toHaveBeenCalledWith(4, { focused: true });
    expect(tabs.create).not.toHaveBeenCalled();
    expect(options.hydrateFromNextCard).toHaveBeenCalled();
  });

  it("keeps the existing website handoff when no setup guide is open", async () => {
    const { tabs, authSender } = mockNavigation([]);
    const { router, reply } = setup();
    router(message, authSender, reply);
    await vi.waitFor(() => expect(tabs.update).toHaveBeenCalledWith(12, {
      url: "https://nextcard.com/get-started-extension",
    }));
    expect(tabs.remove).not.toHaveBeenCalled();
  });

  it("recovers into a guide if the original guide closes during sign-in", async () => {
    const { tabs, authSender, welcomeUrl } = mockNavigation([{ id: 10, windowId: 4 }]);
    tabs.update.mockRejectedValueOnce(new Error("Tab closed"));
    const { router, reply } = setup();
    router(message, authSender, reply);
    await vi.waitFor(() => expect(tabs.update).toHaveBeenCalledWith(12, { url: welcomeUrl }));
    expect(tabs.remove).not.toHaveBeenCalled();
  });

  it("does not navigate away when credentials cannot be saved", async () => {
    const { tabs, authSender } = mockNavigation([{ id: 10, windowId: 4 }]);
    const { router, reply } = setup(vi.fn(async () => { throw new Error("storage failed"); }));
    router(message, authSender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: "sign_in_failed" }));
    expect(tabs.query).not.toHaveBeenCalled();
    expect(tabs.remove).not.toHaveBeenCalled();
  });

  it("keeps the channel open and acknowledges only persisted credentials", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { options, router, reply } = setup(vi.fn(() => pending));
    expect(router(message, sender, reply)).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(options.resetAuthCache).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("reports a persistence failure without success or hydration", async () => {
    const { options, router, reply } = setup(vi.fn(async () => { throw new Error("storage failed"); }));
    router(message, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: "sign_in_failed" }));
    expect(options.hydrateFromNextCard).not.toHaveBeenCalled();
    expect(options.resetAuthCache).not.toHaveBeenCalled();
  });

  it("does not delay acknowledgement on optional hydration", async () => {
    const { options, router, reply } = setup();
    options.hydrateFromNextCard.mockImplementation(() => new Promise(() => {}));
    router(message, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
  });

  it("rejects credentials from an untrusted origin", () => {
    const { options, router, reply } = setup();
    router(message, { url: "https://example.com" }, reply);
    expect(reply).toHaveBeenCalledWith({ ok: false });
    expect(options.setAuth).not.toHaveBeenCalled();
  });
});
