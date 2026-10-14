/** The sidebar reminder follows Chrome's toolbar state, independent of sign-in. */
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
  let dismissed = false;
  let revision = 0;
  let disposed = false;

  function apply(isOnToolbar: boolean) {
    if (disposed) return;
    if (pinned !== isOnToolbar) dismissed = false;
    pinned = isOnToolbar;
    reminder.hidden = pinned || dismissed;
  }

  async function refresh() {
    const currentRevision = ++revision;
    try {
      const settings = await action.getUserSettings();
      if (currentRevision === revision) apply(settings.isOnToolbar);
    } catch {
      // Unknown state stays quiet. Retry when the sidebar regains focus.
    }
  }

  function onSettingsChanged(change: Partial<chrome.action.UserSettings>) {
    if (typeof change.isOnToolbar !== "boolean") return;
    revision += 1;
    apply(change.isOnToolbar);
  }
  function dismiss() {
    dismissed = true;
    reminder.hidden = true;
  }
  const onFocus = () => {
    void refresh();
  };
  const onVisibilityChanged = () => {
    if (!document.hidden) void refresh();
  };

  dismissButton.addEventListener("click", dismiss);
  action.onUserSettingsChanged?.addListener(onSettingsChanged);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChanged);
  window.addEventListener(
    "pagehide",
    () => {
      disposed = true;
      revision += 1;
      dismissButton.removeEventListener("click", dismiss);
      action.onUserSettingsChanged?.removeListener(onSettingsChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChanged);
    },
    { once: true },
  );
  void refresh();
}
