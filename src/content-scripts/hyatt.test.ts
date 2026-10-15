// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.hyatt.com/en-US/member/sign-in?returnUrl=https%3A%2F%2Fwww.hyatt.com%2Fprofile%2Fen-US%2Faccount-overview"}
import { afterEach, expect, it, vi } from "vitest";
import { showOverlay } from "../lib/overlay";

vi.mock("../lib/overlay", () => ({ showOverlay: vi.fn(), updateOverlay: vi.fn(), updateOverlayProgress: vi.fn() }));
vi.mock("../lib/login-state-monitor", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/login-state-monitor")>(),
  createLoginStateMonitor: (options: { detectLoginState: () => string }) => ({ start() {}, getState: options.detectLoginState }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps sign-in interactive despite a saved extracting state and waits for real account content", async () => {
  vi.stubGlobal("chrome", { runtime: {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn((_message: unknown, reply?: (response: unknown) => void) => {
      reply?.({ status: "extracting", progressMessage: "Reading Hyatt points and tier..." });
      return Promise.resolve(null);
    }),
  } });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return { length: this.hasAttribute("hidden") ? 0 : 1, item: () => null, [Symbol.iterator]: () => [][Symbol.iterator]() };
  });
  const { detectLoginState } = await import("./hyatt");
  expect(detectLoginState()).toBe("logged_out");
  expect(showOverlay).toHaveBeenCalledWith("waiting_for_login", "hyatt");
  expect(showOverlay).not.toHaveBeenCalledWith("extracting", "hyatt");
  window.history.replaceState(null, "", "/profile/en-US/account-overview");
  document.body.innerHTML = '<main>Loading your account</main>';
  expect(detectLoginState()).toBe("unknown");
  document.body.innerHTML = '<span data-locator="points-balance" hidden>500</span>';
  expect(detectLoginState()).toBe("unknown");
  document.body.innerHTML = '<span data-locator="points-balance">0</span>';
  expect(detectLoginState()).toBe("logged_in");
  document.body.insertAdjacentHTML("beforeend", '<input type="email">');
  expect(detectLoginState()).toBe("logged_out");
  window.history.replaceState(null, "", "/en-US/member/verify");
  expect(detectLoginState()).toBe("mfa_challenge");
});
