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
  const sendMessage = vi.fn(async () => ({ ok: true }));
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
  const cancel = currentRoot().querySelector(".nc-cancel-button");
  if (!(cancel instanceof HTMLButtonElement)) throw new Error("Missing cancel button");
  cancel.click();
  await vi.advanceTimersByTimeAsync(300);
  expect(sendMessage).toHaveBeenCalledWith({ type: "CANCEL_SYNC", provider: "capitalone" });
  expect(currentRoot().textContent).toContain("Sync cancelled");
  await vi.advanceTimersByTimeAsync(1500);
  expect(document.getElementById("nextcard-sync-overlay")).toBeNull();
});
