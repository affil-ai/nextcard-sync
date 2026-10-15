// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOfferOperation,
  OFFER_OPERATION_STORAGE_KEY,
} from "../lib/offer-operation";

let auth: { token: string } | null;
let pinned: boolean;
let stored: Record<string, unknown>;
let storageChanged: (() => void) | undefined;
let open: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  auth = null;
  pinned = false;
  stored = {};
  storageChanged = undefined;
  open = vi.fn().mockResolvedValue(undefined);
  sendMessage = vi.fn(async (message: { type: string }) =>
    message.type === "GET_AUTH_STATE" ? auth : { ok: true },
  );
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync("src/welcome/index.html", "utf8"),
    "text/html",
  ).body.innerHTML;
  vi.stubGlobal("chrome", {
    windows: { getCurrent: vi.fn().mockResolvedValue({ id: 42 }) },
    sidePanel: { open },
    runtime: { sendMessage },
    action: { getUserSettings: vi.fn(async () => ({ isOnToolbar: pinned })) },
    storage: {
      local: { get: vi.fn(async () => stored) },
      onChanged: {
        addListener: (listener: () => void) => {
          storageChanged = listener;
        },
        removeListener: vi.fn(),
      },
    },
  });
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function primaryButton() {
  const button = document.getElementById("open-extension");
  if (!(button instanceof HTMLButtonElement))
    throw new Error("Missing open button");
  return button;
}
function expectStep(name: string) {
  expect(document.querySelector(".setup")?.getAttribute("data-step")).toBe(
    name,
  );
}
async function load() {
  await import("./welcome");
  await vi.waitFor(() => expect(primaryButton().disabled).toBe(false));
  await vi.waitFor(() =>
    expect(document.querySelector(".setup")?.getAttribute("data-step")).toBe(
      "open",
    ),
  );
}

describe("guided install setup", () => {
  it("opens the panel in the user gesture and advances only on success", async () => {
    await load();
    expect(open).not.toHaveBeenCalled();
    expect(document.getElementById("step-detail")?.textContent).toBe("");
    expect(document.body.textContent).not.toContain("Reopen this guide");
    primaryButton().click();
    expect(open).toHaveBeenCalledWith({ windowId: 42 });
    await vi.waitFor(() => expectStep("pin"));
    expect(document.getElementById("skip-pin")?.hidden).toBe(false);
    const pause = document.getElementById("animation-toggle");
    pause?.click();
    expect(document.querySelector(".setup")?.classList.contains("animation-paused")).toBe(true);
    expect(pause?.textContent).toBe("Play animation");
    pause?.click();
    expect(document.querySelector(".setup")?.classList.contains("animation-paused")).toBe(false);

    expect(document.querySelectorAll('[aria-current="step"]').length).toBe(1);
  });

  it("keeps the open step and shows toolbar instructions when opening fails", async () => {
    open.mockRejectedValue(new Error("Panel unavailable"));
    await load();
    primaryButton().click();
    await vi.waitFor(() =>
      expect(document.getElementById("panel-status")?.textContent).toContain(
        "Could not open the panel",
      ),
    );
    expectStep("open");
  });

  it("does not mark an unpinned extension complete and allows skipping", async () => {
    await load();
    primaryButton().click();
    await vi.waitFor(() => expectStep("pin"));
    expect(primaryButton().hidden).toBe(true);
    expectStep("pin");
    document.getElementById("skip-pin")?.click();
    await vi.waitFor(() => expectStep("sign-in"));
    expect(
      document.querySelectorAll(".progress li")[1]?.getAttribute("aria-label"),
    ).toContain("skipped");
    primaryButton().click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({ type: "SIGN_IN_NEXTCARD" }),
    );
    expectStep("sign-in");
    auth = { token: "synthetic-token" };
    storageChanged?.();
    await vi.waitFor(() => expectStep("activate"));
  });

  it("observes real pin state and skips sign-in only when already connected", async () => {
    auth = { token: "synthetic-token" };
    await load();
    primaryButton().click();
    await vi.waitFor(() => expectStep("pin"));
    pinned = true;
    storageChanged?.();
    await vi.waitFor(() => expectStep("activate"));
    expect(document.querySelectorAll(".progress .completed").length).toBe(3);
    expect(
      document.querySelector(".setup")?.classList.contains("is-pinned"),
    ).toBe(true);
  });

  it("shows completion only after new offers are actually activated and saved", async () => {
    auth = { token: "synthetic-token" };
    const operation = createOfferOperation(
      "chase",
      "test-run",
      new Date(Date.now() - 60_000).toISOString(),
    );
    const result = {
      ...operation,
      phase: "completed",
      added: 2,
      saveStatus: "saved",
    };
    stored = {
      [OFFER_OPERATION_STORAGE_KEY]: {
        active: null,
        history: { chase: result },
      },
    };
    await load();
    primaryButton().click();
    await vi.waitFor(() => expectStep("pin"));
    document.getElementById("skip-pin")?.click();
    await vi.waitFor(() => expectStep("activate"));
    result.startedAt = new Date(Date.now() + 1000).toISOString();
    result.saveStatus = "queued_for_retry";
    storageChanged?.();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expectStep("activate");
    result.saveStatus = "saved";
    storageChanged?.();
    await vi.waitFor(() => expectStep("done"));
    expect(primaryButton().hidden).toBe(true);
    expect(document.getElementById("view-offers")?.hidden).toBe(false);
  });
});
