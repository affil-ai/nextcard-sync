// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<button id="open-extension" disabled>Open nextcard sync</button><p id="panel-status" role="status"></p>';
});
afterEach(() => vi.unstubAllGlobals());

describe("welcome page handoff", () => {
  it("opens the current window’s panel on click and confirms the next step", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      windows: { getCurrent: vi.fn().mockResolvedValue({ id: 42 }) },
      sidePanel: { open },
    });
    await import("./welcome");
    const button = document.getElementById("open-extension");
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing open button");
    expect(button.disabled).toBe(false);
    expect(open).not.toHaveBeenCalled();
    button.click();
    // The API call happens synchronously in the user gesture.
    expect(open).toHaveBeenCalledWith({ windowId: 42 });
    await Promise.resolve();
    expect(document.getElementById("panel-status")?.textContent).toContain("open beside this page");
  });

  it("gives toolbar instructions when Chrome rejects opening the panel", async () => {
    vi.stubGlobal("chrome", {
      windows: { getCurrent: vi.fn().mockResolvedValue({ id: 42 }) },
      sidePanel: { open: vi.fn().mockRejectedValue(new Error("Panel unavailable")) },
    });
    await import("./welcome");
    document.getElementById("open-extension")?.click();
    await vi.waitFor(() => {
      expect(document.getElementById("panel-status")?.textContent).toContain("Could not open the panel");
    });
  });
});
