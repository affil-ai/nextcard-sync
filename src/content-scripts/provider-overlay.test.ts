// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showOverlay, removeOverlay } from "../lib/overlay";
import { providerIds } from "../providers/provider-registry";

vi.mock("../lib/overlay", () => ({ showOverlay: vi.fn(), removeOverlay: vi.fn(), updateOverlayProgress: vi.fn() }));
vi.mock("../lib/login-state-monitor", () => ({ isMfaPage: () => location.hash === "#mfa" }));
let response: unknown;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks();
  location.hash = "";
  response = { status: "idle" };
  vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => response) } });
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

it.each(providerIds)("bootstraps the %s sign-in overlay independently of its scraper", async provider => {
  response = { provider, kind: "rewards", operationId: "attempt", status: "waiting_for_login" };
  await import("./provider-overlay");
  await vi.advanceTimersByTimeAsync(0);
  expect(showOverlay).toHaveBeenCalledWith("waiting_for_login", provider, {
    statusMessage: { type: "GET_PAGE_OVERLAY_STATUS", provider, kind: "rewards", operationId: "attempt" },
    cancelMessage: { type: "CANCEL_PAGE_OVERLAY_OPERATION", provider, kind: "rewards", operationId: "attempt" },
  });
  response = { status: "idle" };
  await vi.advanceTimersByTimeAsync(1_000);
  expect(removeOverlay).toHaveBeenCalledOnce();
});

it("does not show a banner on an unrelated tab and switches to MFA when needed", async () => {
  await import("./provider-overlay");
  await vi.advanceTimersByTimeAsync(0);
  expect(showOverlay).not.toHaveBeenCalled();
  expect(removeOverlay).not.toHaveBeenCalled();
  location.hash = "#mfa";
  response = { provider: "amex", kind: "offers", operationId: "offer-run", status: "waiting_for_login" };
  await vi.advanceTimersByTimeAsync(1_000);
  expect(showOverlay).toHaveBeenCalledWith("mfa_challenge", "amex", expect.objectContaining({
    cancelMessage: expect.objectContaining({ kind: "offers", operationId: "offer-run" }),
  }));
});
