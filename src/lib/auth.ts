/**
 * NextCard authentication for the Chrome extension.
 *
 * Flow:
 *   1. Extension opens a tab to nextcard.com/extension-auth?extId=<id>
 *   2. User signs in via Clerk (or is already signed in)
 *   3. The page generates a long-lived extension token and sends it
 *      back via chrome.runtime.sendMessage(extId, { ... })
 *   4. Extension stores the token in chrome.storage.local
 */

import type { NextCardAuth } from "./types";

const STORAGE_KEY = "nextcard_auth";

const AUTH_BASE_URL = __NEXTCARD_URL__;

export function getAuthUrl(): string {
  const extId = chrome.runtime.id;
  return `${AUTH_BASE_URL}/extension-auth?extId=${extId}`;
}

export async function getAuth(): Promise<NextCardAuth | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? null;
}

export async function setAuth(auth: NextCardAuth): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: auth });
}

export async function clearAuth(): Promise<void> {
  await chrome.storage.local.clear();
}

/**
 * Opens a tab to the NextCard auth page.
 * The actual token comes back via chrome.runtime.onMessageExternal,
 * which is handled in the service worker.
 */
export async function startSignIn(): Promise<void> {
  await chrome.tabs.create({ url: getAuthUrl(), active: true });
}

/**
 * Checks if the stored token is still valid on the server.
 * Returns false (and clears local auth) if the token was revoked or deleted.
 */
export async function verifyAuth(): Promise<boolean> {
  const auth = await getAuth();
  if (!auth) return false;

  try {
    const res = await fetch(`${__CONVEX_SITE_URL__}/extension/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const data = await res.json();
    if (!data.valid) {
      await clearAuth();
      return false;
    }
    return true;
  } catch {
    // Network error — don't log out, just return current state
    return true;
  }
}
