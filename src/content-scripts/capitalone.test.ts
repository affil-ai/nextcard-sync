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

it.each([
  { text: "125,000 miles", amount: 125000, label: "Miles" },
  { text: "$10 <sup>83</sup> cash back", amount: 10.83, label: "Cash Back" },
])("reads the rewards display when inner selectors change: $label", async ({ text, amount, label }) => {
  vi.resetModules();
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/rewards");
  type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  let extractionListener: MessageListener | undefined;
  const sendMessage = vi.fn(async () => null);
  vi.stubGlobal("chrome", { runtime: {
    onMessage: { addListener: (listener: MessageListener) => { extractionListener = listener; } },
    sendMessage,
  } });
  const rect = new DOMRect(0, 0, 100, 20);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => ({
    length: 1, 0: rect, item: () => rect, [Symbol.iterator]: () => [rect][Symbol.iterator](),
  }));
  document.body.innerHTML = `<main><div>Current balance $9,999</div><c1-ease-card-rewards-display>${text}</c1-ease-card-rewards-display></main>`;
  try {
    await import("./capitalone");
    if (!extractionListener) throw new Error("Missing extraction listener");
    extractionListener({ type: "START_EXTRACTION", attemptId: "balance-read" }, {}, () => {});
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "CAPITALONE_REWARDS_DONE", miles: amount, rewardsLabel: label,
    }));
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/accountSummary");
  }
});
