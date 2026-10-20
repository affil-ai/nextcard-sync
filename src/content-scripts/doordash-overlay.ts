import { showOverlay, removeOverlay } from "../lib/overlay";

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("src/popup/popup.html")) return false;
  if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "DOORDASH_PAGE_OVERLAY" || !("state" in message)) return false;
  if (message.state === "waiting") showOverlay("waiting_for_login");
  else if (message.state === "clear") removeOverlay();
  else return false;
  respond({ ok: true });
  return false;
});

// The popup may have reached the sign-in page before this script loaded.
void chrome.runtime.sendMessage({ type: "DOORDASH_OVERLAY_READY" }).catch(() => {});
