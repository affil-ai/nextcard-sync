// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializePinReminder } from "./pin-reminder";

let pinned = false;
let changePin:
  | ((change: Partial<chrome.action.UserSettings>) => void)
  | undefined;
let getUserSettings: ReturnType<typeof vi.fn>;
let removeListener: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pinned = false;
  changePin = undefined;
  getUserSettings = vi.fn(async () => ({ isOnToolbar: pinned }));
  removeListener = vi.fn();
  const html = new DOMParser().parseFromString(
    readFileSync("src/popup/popup.html", "utf8"),
    "text/html",
  );
  const reminder = html.getElementById("pinReminder");
  if (!reminder) throw new Error("Missing sidebar pin reminder");
  document.body.replaceChildren(reminder);
  vi.stubGlobal("chrome", {
    action: {
      getUserSettings,
      onUserSettingsChanged: {
        addListener: (listener: typeof changePin) => {
          changePin = listener;
        },
        removeListener,
      },
    },
  });
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.unstubAllGlobals();
});
function reminder() {
  const element = document.getElementById("pinReminder");
  if (!element) throw new Error("Missing reminder");
  return element;
}

it("shows while unpinned, hides immediately on pin, and returns on unpin", async () => {
  initializePinReminder();
  expect(reminder().hidden).toBe(true);
  await vi.waitFor(() => expect(reminder().hidden).toBe(false));
  changePin?.({ isOnToolbar: true });
  expect(reminder().hidden).toBe(true);
  changePin?.({ isOnToolbar: false });
  expect(reminder().hidden).toBe(false);
});

it("stays hidden for a pinned extension on startup", async () => {
  pinned = true;
  initializePinReminder();
  await vi.waitFor(() => expect(getUserSettings).toHaveBeenCalled());
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
});

it("keeps dismissal until the next pin/unpin transition", async () => {
  initializePinReminder();
  await vi.waitFor(() => expect(reminder().hidden).toBe(false));
  document.getElementById("dismissPinReminder")?.click();
  expect(reminder().hidden).toBe(true);
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
  changePin?.({ isOnToolbar: true });
  changePin?.({ isOnToolbar: false });
  expect(reminder().hidden).toBe(false);
});

it("ignores stale reads when a pin event arrives first and removes its listener on close", async () => {
  let finish: ((settings: chrome.action.UserSettings) => void) | undefined;
  getUserSettings.mockImplementation(
    () =>
      new Promise<chrome.action.UserSettings>((resolve) => {
        finish = resolve;
      }),
  );
  initializePinReminder();
  changePin?.({ isOnToolbar: true });
  finish?.({ isOnToolbar: false });
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
  window.dispatchEvent(new Event("pagehide"));
  expect(removeListener).toHaveBeenCalledWith(changePin);
  changePin?.({ isOnToolbar: false });
  expect(reminder().hidden).toBe(true);
});

it("stays quiet on API errors and checks again on focus without the change-event API", async () => {
  vi.stubGlobal("chrome", { action: { getUserSettings } });
  getUserSettings.mockRejectedValueOnce(new Error("Unavailable"));
  initializePinReminder();
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(reminder().hidden).toBe(false));
});
