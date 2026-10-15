const DISMISSED_KEY = "pinReminderDismissed";

/** Show the toolbar pointer while unpinned, until explicitly hidden. */
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

  function render() {
    if (!disposed) reminder.hidden = pinned !== false || dismissed;
  }
  async function refresh() {
    const currentRevision = ++revision;
    try {
      const [settings, stored] = await Promise.all([
        action.getUserSettings(),
        chrome.storage.local.get(DISMISSED_KEY),
      ]);
      if (disposed) return;
      dismissed ||= stored[DISMISSED_KEY] === true;
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
    if (changes[DISMISSED_KEY]) dismissed = changes[DISMISSED_KEY].newValue === true;
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
