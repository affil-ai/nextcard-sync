import { afterEach, expect, it, vi } from "vitest";
import { showOverlay, removeOverlay } from "../lib/overlay";

vi.mock("../lib/overlay", () => ({ showOverlay: vi.fn(), removeOverlay: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("shows and dismisses the shared sign-in overlay only for the extension popup", async () => {
  let handler: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | undefined;
  const sendMessage = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", { runtime: {
    id: "test", getURL: (path: string) => `chrome-extension://test/${path}`, sendMessage,
    onMessage: { addListener: (listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0]) => { handler = listener; } },
  } });
  await import("./doordash-overlay");
  if (!handler) throw new Error("Missing overlay listener");
  const respond = vi.fn();
  const message = { type: "DOORDASH_PAGE_OVERLAY", state: "waiting" };
  handler(message, { id: "test", url: "https://identity.doordash.com/auth" }, respond);
  handler(message, { id: "other", url: "chrome-extension://test/src/popup/popup.html" }, respond);
  expect(showOverlay).not.toHaveBeenCalled();
  const popup = { id: "test", url: "chrome-extension://test/src/popup/popup.html" };
  handler(message, popup, respond);
  expect(showOverlay).toHaveBeenCalledWith("waiting_for_login");
  handler({ type: "DOORDASH_PAGE_OVERLAY", state: "clear" }, popup, respond);
  expect(removeOverlay).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledWith({ ok: true });
  expect(sendMessage).toHaveBeenCalledWith({ type: "DOORDASH_OVERLAY_READY" });
});
