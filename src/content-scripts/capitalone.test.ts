// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://myaccounts.capitalone.com/accountSummary"}
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../lib/overlay", () => ({ showOverlay: vi.fn(), updateOverlay: vi.fn(), updateOverlayProgress: vi.fn(), hideOverlay: vi.fn() }));
vi.mock("../lib/login-state-monitor", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/login-state-monitor")>(),
  createLoginStateMonitor: () => ({ start() {}, check() {}, getState: () => "unknown" }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("requires visible account data and keeps MFA ahead of stale account tiles", async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => null),
    },
  });
  const rect = new DOMRect(0, 0, 100, 20);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const element = this;
    const visible = element instanceof HTMLElement && !element.hidden && element.style.display !== "none";
    return { length: visible ? 1 : 0, 0: rect, item: () => visible ? rect : null, [Symbol.iterator]: () => (visible ? [rect] : [])[Symbol.iterator]() };
  });
  const { detectLoginState } = await import("./capitalone");
  document.body.innerHTML = '<main>We can’t access your account information right now, but we’re working on it.</main>';
  expect(detectLoginState()).toBe("unknown");
  document.body.innerHTML = '<main>Loading your accounts</main>';
  expect(detectLoginState()).toBe("unknown");
  document.body.innerHTML = '<div class="account-tile"><span class="primary-detail__identity__account-number">1234</span></div>';
  expect(detectLoginState()).toBe("logged_in");
  document.body.insertAdjacentHTML("beforeend", "<main>We can’t access your account information right now</main>");
  expect(detectLoginState()).toBe("unknown");
  document.querySelector("main")?.remove();
  document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><h1>Verify it\'s you</h1><button>Send a code</button></div>');
  expect(detectLoginState()).toBe("mfa_challenge");
  document.querySelector("[role=dialog]")?.remove();
  expect(detectLoginState()).toBe("logged_in");
  document.body.innerHTML = '<div class="loyalty-tile" hidden>100,000 miles</div>';
  expect(detectLoginState()).toBe("unknown");
});
