// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOfferOperation, OFFER_OPERATION_STORAGE_KEY } from "../lib/offer-operation";
import { initializePinReminder } from "./pin-reminder";

let stored: Record<string, unknown>;
let storageChanged: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
let pinned = false;
let changePin:
  | ((change: Partial<chrome.action.UserSettings>) => void)
  | undefined;
let getUserSettings: ReturnType<typeof vi.fn>;
let removeListener: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pinned = false;
  stored = { pinReminderEligible: true };
  storageChanged = undefined;
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
    storage: {
      local: {
        get: vi.fn(async () => stored),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(stored, values)),
      },
      onChanged: {
        addListener: (listener: typeof storageChanged) => { storageChanged = listener; },
        removeListener: vi.fn(),
      },
    },
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

it("keeps explicit dismissal across pin changes and sidebar reopening", async () => {
  initializePinReminder();
  await vi.waitFor(() => expect(reminder().hidden).toBe(false));
  document.getElementById("dismissPinReminder")?.click();
  expect(reminder().hidden).toBe(true);
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
  changePin?.({ isOnToolbar: true });
  changePin?.({ isOnToolbar: false });
  expect(reminder().hidden).toBe(true);
  await vi.waitFor(() => expect(stored.pinReminderDismissed).toBe(true));
  window.dispatchEvent(new Event("pagehide"));
  initializePinReminder();
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
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
  vi.stubGlobal("chrome", { ...chrome, action: { getUserSettings } });
  getUserSettings.mockRejectedValueOnce(new Error("Unavailable"));
  initializePinReminder();
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(reminder().hidden).toBe(false));
});

it("waits until offers have been activated before showing a reminder", async () => {
  stored = {};
  initializePinReminder();
  await vi.waitFor(() => expect(getUserSettings).toHaveBeenCalled());
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
  const operation = { ...createOfferOperation("chase", "pin-run"), phase: "completed", added: 2, saveStatus: "saved" };
  storageChanged?.({ [OFFER_OPERATION_STORAGE_KEY]: { newValue: { active: null, history: { chase: operation } } } }, "local");
  await vi.waitFor(() => expect(reminder().hidden).toBe(false));
  expect(stored.pinReminderEligible).toBe(true);
});

it("recognizes BofA activation and ignores checks with no activations", async () => {
  stored = {};
  initializePinReminder();
  await Promise.resolve();
  storageChanged?.({ bofa_portal_operation: { newValue: { state: { phase: "ready", added: 0 } } } }, "local");
  await Promise.resolve();
  expect(reminder().hidden).toBe(true);
  storageChanged?.({ bofa_portal_operation: { newValue: { state: { phase: "completed", added: 1 } } } }, "local");
  await vi.waitFor(() => expect(reminder().hidden).toBe(false));
});
