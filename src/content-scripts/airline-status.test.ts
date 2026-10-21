// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../lib/overlay", () => ({
  showOverlay: vi.fn(), updateOverlay: vi.fn(), updateOverlayProgress: vi.fn(),
}));
vi.mock("../lib/login-state-monitor", () => ({
  createLoginStateMonitor: () => ({ start() {}, getState: () => "logged_in" }),
}));
beforeEach(() => {
  Object.defineProperty(document.body, "innerText", {
    configurable: true, get() { return document.body.textContent ?? ""; },
  });
  vi.stubGlobal("chrome", { runtime: {
    onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(),
  } });
});
afterEach(() => {
  document.body.innerHTML = "";
  Reflect.deleteProperty(document.body, "innerText");
  vi.unstubAllGlobals();
});

it.each([
  { heading: null, expected: "MileagePlus Member" },
  { heading: "Premier progress", expected: "MileagePlus Member" },
  { heading: "Progress to Premier Gold", expected: "MileagePlus Member" },
  { heading: "Premier Silver", expected: "Premier Silver" },
  { heading: "Your status: Premier Gold", expected: "Premier Gold" },
  { heading: "Premier Platinum", expected: "Premier Platinum" },
  { heading: "Premier 1K", expected: "Premier 1K" },
  { heading: "Global Services", expected: "Global Services" },
  { heading: "MileagePlus Member", expected: "MileagePlus Member" },
])("United reads current status with a Member fallback for $heading", async ({ heading, expected }) => {
  const { scrapeAccountPage } = await import("./united");
  document.body.innerHTML = '<div class="MileageBalance__totalMiles">1,859</div><p>Become a MileagePlus Member</p>';
  if (heading !== null) {
    const el = document.createElement("div");
    el.className = "PremierProgress__headerText";
    el.textContent = heading;
    document.body.append(el);
  }
  expect(scrapeAccountPage()).toMatchObject({ milesBalance: 1859, eliteStatus: expected });
});

it.each([
  { markup: '<p>Member benefits include Elite Gold perks</p>', expected: null },
  { markup: '<div class="loyalty-tile">MY STATUS: Loading</div><p>Member benefits</p>', expected: null },
  { markup: '<p>Member benefits</p><div class="loyalty-tile">MY STATUS:<div class="tile-hero">Elite Silver</div></div>', expected: "Elite Silver" },
  { markup: '<div class="loyalty-tile">MY STATUS: Member</div>', expected: "Member" },
  { markup: '<p>Member since 2020</p><div class="loyalty-tile">Your Status Tier: Elite Gold Current Points Balance: 100 <div class="benefit-container-highlighted">Elite Platinum</div></div>', expected: "Elite Gold" },
  { markup: '<div class="loyalty-tile">Your Status Tier: Loading Current Points Balance: 100 <div class="benefit-container-highlighted">Elite Diamond</div></div>', expected: null },
])("Frontier requires a current account status label: $expected", async ({ markup, expected }) => {
  const { scrapeAccountPage } = await import("./frontier");
  document.body.innerHTML = markup;
  expect(scrapeAccountPage().eliteStatus).toBe(expected);
});
