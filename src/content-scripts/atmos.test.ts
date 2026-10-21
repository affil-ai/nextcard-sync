// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.alaskaair.com/atmosrewards/account/overview/"}
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../lib/overlay", () => ({
  showOverlay: vi.fn(), updateOverlay: vi.fn(), updateOverlayProgress: vi.fn(),
}));
vi.mock("../lib/login-state-monitor", () => ({
  createLoginStateMonitor: () => ({ start() {}, getState: () => "logged_in" }),
}));
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it.each([
  { status: "Atmos™ Silver / <strong>one</strong>world® Ruby", expected: "Atmos™ Silver / oneworld® Ruby" },
  { status: "Atmos™ Gold / oneworld® Sapphire", expected: "Atmos™ Gold / oneworld® Sapphire" },
  { status: "Atmos™ Member", expected: "Atmos™ Member" },
  { status: "", expected: null },
])("reads the account tier without requiring Member: $expected", async ({ status, expected }) => {
  vi.stubGlobal("chrome", { runtime: {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
  } });
  const { scrapeOverviewPage } = await import("./atmos");
  document.body.innerHTML = `<div class="loyalty-header-row">
    <div class="info-row"><div>${status}</div></div>
    <div class="info-row">Rewards No. 123456789</div>
  </div><div class="available-points-section"><span class="points-value">200,202</span></div>`;
  expect(scrapeOverviewPage()).toMatchObject({
    statusLevel: expected, memberNumber: "123456789", availablePoints: 200202,
  });
});

it("preserves legacy tier markup", async () => {
  vi.stubGlobal("chrome", { runtime: {
    onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(),
  } });
  const { scrapeOverviewPage } = await import("./atmos");
  document.body.innerHTML = '<div class="member-tier-row"><div>MVP Gold</div></div>';
  expect(scrapeOverviewPage().statusLevel).toBe("MVP Gold");
});
