// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps sign-in nonblocking and offers cancellation during login and reading", async () => {
  vi.useFakeTimers();
  let root: ShadowRoot | null = null;
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, options) {
    root = attach.call(this, options);
    return root;
  });
  let polledStatus = "extracting";
  let accountPreparation = false;
  const sendMessage = vi.fn((_message: unknown, reply?: (response: { status: string; accountPreparation: { attemptId: string; memberDisplayName: string } | null }) => void) => {
    reply?.({ status: polledStatus, accountPreparation: accountPreparation ? { attemptId: "run-1", memberDisplayName: "Mom" } : null });
    return Promise.resolve({ ok: true });
  });
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path, sendMessage } });
  const overlay = await import("./overlay");
  overlay.showOverlay("mfa_challenge", "capitalone");
  await vi.advanceTimersByTimeAsync(20);
  expect(document.getElementById("nextcard-sync-overlay")?.classList.contains("nc-login")).toBe(true);
  function currentRoot() { if (!root) throw new Error("Missing overlay"); return root; }
  expect(currentRoot().textContent).toContain("Complete the security verification");
  expect(currentRoot().querySelector(".nc-cancel-button")?.textContent).toBe("Cancel sync");
  overlay.updateOverlay("extracting", "capitalone");
  await vi.advanceTimersByTimeAsync(300);
  polledStatus = "waiting_for_login";
  accountPreparation = true;
  await vi.advanceTimersByTimeAsync(2300);
  expect(currentRoot().textContent).toContain("Check the signed-in account");
  expect(currentRoot().textContent).toContain("Continue sync in the sidebar");
  expect(currentRoot().textContent).not.toContain("read your data automatically");
  expect(currentRoot().textContent).not.toContain("Don't click anything");
  accountPreparation = false;
  polledStatus = "extracting";
  await vi.advanceTimersByTimeAsync(2300);
  expect(currentRoot().textContent).toContain("nextcard is reading your account");
  polledStatus = "awaiting_confirmation";
  await vi.advanceTimersByTimeAsync(2000);
  expect(document.getElementById("nextcard-sync-overlay")).toBeNull();
  expect(sendMessage).not.toHaveBeenCalledWith({ type: "CANCEL_SYNC", provider: "capitalone" });
  const pollCount = sendMessage.mock.calls.length;
  await vi.advanceTimersByTimeAsync(4000);
  expect(sendMessage).toHaveBeenCalledTimes(pollCount);
  overlay.showOverlay("extracting", "capitalone");
  await vi.advanceTimersByTimeAsync(20);
  const cancel = currentRoot().querySelector(".nc-cancel-button");
  if (!(cancel instanceof HTMLButtonElement)) throw new Error("Missing cancel button");
  cancel.click();
  await vi.advanceTimersByTimeAsync(300);
  expect(sendMessage).toHaveBeenCalledWith({ type: "CANCEL_SYNC", provider: "capitalone" });
  expect(currentRoot().textContent).toContain("Sync cancelled");
  await vi.advanceTimersByTimeAsync(1500);
  expect(document.getElementById("nextcard-sync-overlay")).toBeNull();
});
