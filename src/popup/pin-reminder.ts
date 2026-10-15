import { z } from "zod";
import {
  normalizeOfferOperationSnapshot,
  OFFER_OPERATION_STORAGE_KEY,
} from "../lib/offer-operation";

const ELIGIBLE_KEY = "pinReminderEligible";
const DISMISSED_KEY = "pinReminderDismissed";
const BOFA_STATE_KEY = "bofa_portal_operation";
const bofaActivation = z.object({ state: z.object({ phase: z.string(), added: z.number() }) });

/** Pinning is optional. Remind only after activation, until explicitly hidden. */
export function initializePinReminder() {
  const reminderElement = document.getElementById("pinReminder");
  const dismissButton = document.getElementById("dismissPinReminder");
  if (!reminderElement || !dismissButton) return;
  const reminder = reminderElement;

  // The installed Chrome typings predate the Chrome 130 change event.
  const action: typeof chrome.action & {
    onUserSettingsChanged?: chrome.events.Event<
      (change: Partial<chrome.action.UserSettings>) => void
    >;
  } = chrome.action;
  let pinned: boolean | undefined;
  let eligible = false;
  let dismissed = false;
  let revision = 0;
  let disposed = false;

  function render() {
    if (!disposed) reminder.hidden = pinned !== false || !eligible || dismissed;
  }
  function rememberActivation(snapshot: unknown, bofa: unknown) {
    if (eligible) return;
    const operations = normalizeOfferOperationSnapshot(snapshot);
    const activated = [operations.active, ...Object.values(operations.history)].some(
      operation => operation && operation.added > 0 &&
        ["completed", "ready_to_add", "cancelled", "failed", "interrupted"].includes(operation.phase),
    );
    const portal = bofaActivation.safeParse(bofa);
    if (activated || (portal.success && portal.data.state.added > 0 &&
      ["completed", "cancelled", "failed"].includes(portal.data.state.phase))) {
      eligible = true;
      void chrome.storage.local.set({ [ELIGIBLE_KEY]: true }).catch(() => {});
    }
  }
  async function refresh() {
    const currentRevision = ++revision;
    try {
      const [settings, stored] = await Promise.all([
        action.getUserSettings(),
        chrome.storage.local.get(eligible
          ? [ELIGIBLE_KEY, DISMISSED_KEY]
          : [ELIGIBLE_KEY, DISMISSED_KEY, OFFER_OPERATION_STORAGE_KEY, BOFA_STATE_KEY]),
      ]);
      if (disposed) return;
      eligible ||= stored[ELIGIBLE_KEY] === true;
      dismissed ||= stored[DISMISSED_KEY] === true;
      rememberActivation(stored[OFFER_OPERATION_STORAGE_KEY], stored[BOFA_STATE_KEY]);
      if (currentRevision === revision) pinned = settings.isOnToolbar;
      render();
    } catch {
      // Unknown state stays quiet. Retry when the sidebar regains focus.
    }
  }
  function onSettingsChanged(change: Partial<chrome.action.UserSettings>) {
    if (typeof change.isOnToolbar !== "boolean") return;
    revision += 1;
    pinned = change.isOnToolbar;
    render();
  }
  function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (disposed || area !== "local") return;
    if (changes[ELIGIBLE_KEY]) eligible = changes[ELIGIBLE_KEY].newValue === true;
    if (changes[DISMISSED_KEY]) dismissed = changes[DISMISSED_KEY].newValue === true;
    rememberActivation(changes[OFFER_OPERATION_STORAGE_KEY]?.newValue, changes[BOFA_STATE_KEY]?.newValue);
    render();
  }
  function dismiss() {
    dismissed = true;
    render();
    void chrome.storage.local.set({ [DISMISSED_KEY]: true }).catch(() => {});
  }
  const onFocus = () => { void refresh(); };
  const onVisibilityChanged = () => {
    if (!document.hidden) void refresh();
  };

  dismissButton.addEventListener("click", dismiss);
  action.onUserSettingsChanged?.addListener(onSettingsChanged);
  chrome.storage.onChanged.addListener(onStorageChanged);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChanged);
  window.addEventListener("pagehide", () => {
    disposed = true;
    revision += 1;
    dismissButton.removeEventListener("click", dismiss);
    action.onUserSettingsChanged?.removeListener(onSettingsChanged);
    chrome.storage.onChanged.removeListener(onStorageChanged);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChanged);
  }, { once: true });
  void refresh();
}
