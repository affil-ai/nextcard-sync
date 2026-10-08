import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/overlay", () => ({
  showOverlay: vi.fn(),
  updateOverlay: vi.fn(),
  updateOverlayProgress: vi.fn(),
  hideOverlay: vi.fn(),
}));

// Sanitized visible-text fixture reconstructed from the support screenshot,
// not a captured DOM. The redesigned wallet has no legacy points pill.
const cardWallet = [
  "Wallet",
  "Test Card •••• 1234",
  "View",
  "Current balance",
  "Remaining statement balance",
  "Min. payment due",
  "Payment due date",
  "Pay card",
  "Scheduled payments",
  "Pay with points",
  "Up to $100.00",
  "Authorized users",
  "Manage card",
  "Lock card",
  "Welcome, Test",
  "Earn 2,500 Bilt Points",
  "Your card rewards",
].join("\n");

type MessageListener = Parameters<typeof chrome.runtime.onMessage.addListener>[0];
const listeners: MessageListener[] = [];
const sendMessage = vi.fn(async (_message: Record<string, unknown>) => ({}));
let bodyText = "";
let passwordVisible = false;
let pointsPill: { textContent: string } | null = null;
let profileVisible = false;
let menuExpanded = false;
let menuDelay = 0;
const menuClick = vi.fn(() => {
  menuExpanded = true;
  setTimeout(() => { bodyText += "\nYour Status\nGold\nYour Points\n123,456"; }, menuDelay);
});
class ProfileTrigger {
  getAttribute(name: string) {
    return name === "aria-expanded" ? String(menuExpanded) : null;
  }
  click() { menuClick(); }
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  listeners.length = 0;
  sendMessage.mockClear();
  bodyText = "";
  passwordVisible = false;
  pointsPill = null;
  profileVisible = false;
  menuExpanded = false;
  menuDelay = 0;
  menuClick.mockClear();
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage,
      onMessage: { addListener: (listener: MessageListener) => listeners.push(listener) },
    },
  });
  vi.stubGlobal("window", {
    location: { href: "https://www.bilt.com/wallet" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("HTMLElement", ProfileTrigger);
  vi.stubGlobal("MutationObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.stubGlobal("document", {
    body: { get innerText() { return bodyText; } },
    querySelector: (selector: string) => {
      if (selector === '[data-testid="user-info-points-pill"]') return pointsPill;
      if (selector === '[data-testid="user-info-profile-avatar"]' && profileVisible) {
        return { closest: () => new ProfileTrigger() };
      }
      if (selector.includes('user-info-profile-avatar') && profileVisible) return {};
      return null;
    },
    querySelectorAll: (selector: string) =>
      selector.includes('input[type="password"]') && passwordVisible
        ? [{ offsetParent: {} }]
        : [],
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function extract() {
  for (const listener of listeners) {
    listener({ type: "START_EXTRACTION", attemptId: "test-attempt" }, { id: "test" }, () => {});
  }
  await vi.advanceTimersByTimeAsync(35_000);
}

function expectStatus(status: string) {
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "STATUS_UPDATE",
    provider: "bilt",
    attemptId: "test-attempt",
    status,
  }));
}

describe("Bilt wallet extraction", () => {
  it("opens the redesigned profile menu and waits for the exact points balance", async () => {
    bodyText = cardWallet;
    profileVisible = true;
    menuDelay = 1200;
    await import("./bilt");
    await extract();
    expect(menuClick).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "EXTRACTION_DONE", data: expect.objectContaining({ pointsBalance: 123456 }),
    }));
  });

  it("keeps an already-open profile menu open while its balance loads", async () => {
    bodyText = cardWallet;
    profileVisible = true;
    menuExpanded = true;
    setTimeout(() => { bodyText += "\nYour Points\n123,456"; }, 4000);
    await import("./bilt");
    await extract();
    expect(menuClick).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "EXTRACTION_DONE", data: expect.objectContaining({ pointsBalance: 123456 }),
    }));
  });

  it("reads the current tier and progress without confusing the next tier with current status", async () => {
    // Sanitized structure observed on the live redesigned status tracker.
    bodyText = ["Gold", "Good through Jan 16, 2028", "Progress to Platinum",
      "110,000", "Points", "200,000", "OR", "FAST TRACK", "$29,000", "Spend", "$50,000",
    ].join("\n");
    profileVisible = true;
    await import("./bilt");
    for (const listener of listeners) {
      listener({ type: "SCRAPE_PROGRESS", attemptId: "test-attempt" }, { id: "test" }, () => {});
    }
    await vi.advanceTimersByTimeAsync(14000);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "BILT_PROGRESS_DONE", progress: {
        eliteStatus: "Gold", statusValidThrough: "Jan 16, 2028",
        pointsProgress: 110000, pointsTarget: 200000,
        spendProgress: "$29,000", spendTarget: "$50,000",
      },
    }));
  });

  it("extracts the redesigned signed-in wallet without treating promotional points as a balance", async () => {
    bodyText = cardWallet;
    await import("./bilt");
    await extract();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "EXTRACTION_DONE",
      data: expect.objectContaining({
        linkedCards: [{ cardName: "Test Card", lastFourDigits: "1234" }],
        pointsBalance: null,
        biltCashBalance: null,
        availableCreditsCount: null,
        housingOnlyRewardsEnabled: null,
        flexibleBiltCashEnabled: null,
      }),
    }));
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "waiting_for_login",
    }));
  });

  it("detects a wallet rendered after sign-in and then extracts it", async () => {
    bodyText = "Sign in";
    await import("./bilt");
    await extract();
    expectStatus("waiting_for_login");

    sendMessage.mockClear();
    bodyText = cardWallet;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "LOGIN_STATE", state: "logged_in",
    }));
    await extract();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "EXTRACTION_DONE" }));
  });

  it("still extracts balances from the legacy points-pill wallet", async () => {
    bodyText = "Your Wallet";
    pointsPill = { textContent: "1,234 pts" };
    await import("./bilt");
    await extract();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "EXTRACTION_DONE", data: expect.objectContaining({ pointsBalance: 1234 }),
    }));
  });

  it("waits for a visible sign-in form even when stale wallet content remains", async () => {
    bodyText = cardWallet;
    pointsPill = { textContent: "1,234 pts" };
    passwordVisible = true;
    await import("./bilt");
    await extract();
    expectStatus("waiting_for_login");
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "EXTRACTION_DONE" }));
  });

  it.each([
    ["unrecognized/loading wallet", "Wallet\nLoading..."],
    ["authenticated wallet without readable rewards", "Wallet\nCurrent balance\nPay card\nManage card"],
  ])("reports a read error, not a sign-in prompt, for an %s", async (_name, text) => {
    bodyText = text;
    await import("./bilt");
    await extract();
    expectStatus("error");
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "waiting_for_login",
    }));
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "EXTRACTION_DONE" }));
  });
});
