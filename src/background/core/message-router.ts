import type { NextCardAuth, ProviderId } from "../../lib/types";
import type { ProviderDefinition, ProviderSyncStrategy } from "../../providers/provider-registry";
import type { createRuntimeStateStore } from "./runtime-state";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

export interface SyncHandlers {
  generic: (providerId: ProviderId) => Promise<void>;
  atmos: () => Promise<void>;
  "chase-v1": () => Promise<void>;
  amex: () => Promise<void>;
  capitalone: () => Promise<void>;
  hyatt: () => Promise<void>;
  bilt: () => Promise<void>;
}

function startStrategy(
  strategy: ProviderSyncStrategy,
  providerId: ProviderId,
  syncHandlers: SyncHandlers,
) {
  switch (strategy) {
    case "generic":
      return syncHandlers.generic(providerId);
    case "atmos":
      return syncHandlers.atmos();
    case "chase-v1":
      return syncHandlers["chase-v1"]();
    case "amex":
      return syncHandlers.amex();
    case "capitalone":
      return syncHandlers.capitalone();
    case "hyatt":
      return syncHandlers.hyatt();
    case "bilt":
      return syncHandlers.bilt();
  }
}

export function resolveSyncStarter(
  providerId: ProviderId,
  providerRegistry: Record<ProviderId, ProviderDefinition>,
  syncHandlers: SyncHandlers,
) {
  return () => startStrategy(providerRegistry[providerId].syncStrategy, providerId, syncHandlers);
}

export function createMessageRouter(options: {
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  syncHandlers: SyncHandlers;
  cancelRun: (providerId: ProviderId, error?: string | null) => Promise<void>;
  startSignIn: () => Promise<void>;
  clearAuth: () => Promise<void>;
  getCachedAuth: () => Promise<NextCardAuth | null>;
  onSignOut: () => void;
  recordConsent: (message: Record<string, unknown>) => Promise<void>;
  pushToNextCard: (providerId: ProviderId, data: unknown) => Promise<unknown>;
  deleteFromNextCard: (providerId: ProviderId) => Promise<{ ok: boolean; error?: string }>;
  syncEnrolledOffers?: (issuer: string, message: Record<string, unknown>) => void;
}) {
  return (message: Record<string, unknown>, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    switch (message.type) {
      case "REQUEST_SYNC": {
        const providerId = message.provider;
        if (!options.stateStore.isProviderId(providerId)) {
          sendResponse({ ok: false, error: `Unknown provider: ${String(providerId)}` });
          return true;
        }

        const startSync = resolveSyncStarter(
          providerId,
          options.providerRegistry,
          options.syncHandlers,
        );
        void startSync().catch((error) => {
          const errorMessage = error instanceof Error ? error.message : "Sync failed";
          options.stateStore.updateProvider(providerId, {
            status: "error",
            error: errorMessage,
          });
          console.error(
            `[NextCard SW] Unhandled ${providerId} sync error:`,
            error,
          );
        });

        options.stateStore
          .waitForSyncStart(providerId)
          .then((started) => {
            if (started) {
              sendResponse({ ok: true });
              return;
            }

            sendResponse({
              ok: false,
              error:
                options.stateStore.states[providerId].error
                ?? `Failed to open ${options.providerRegistry[providerId].name}`,
            });
          })
          .catch((error) => {
            const errorMessage =
              error instanceof Error ? error.message : "Failed to start sync";
            sendResponse({ ok: false, error: errorMessage });
          });
        return true;
      }

      case "CANCEL_SYNC": {
        const providerId = message.provider;
        if (!options.stateStore.isProviderId(providerId)) {
          sendResponse({ ok: false });
          return true;
        }

        options.cancelRun(providerId)
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            const cancelMessage =
              error instanceof Error ? error.message : "Cancel failed";
            console.error(
              `[NextCard SW] Failed to cancel ${providerId} sync:`,
              error,
            );
            sendResponse({ ok: false, error: cancelMessage });
          });
        return true;
      }

      case "CLEAR_DATA": {
        const providerId = message.provider;
        if (options.stateStore.isProviderId(providerId)) {
          options.stateStore.updateProvider(providerId, {
            status: "idle",
            data: null,
            error: null,
            lastSyncedAt: null,
          });
          options.stateStore.setTabId(providerId, null);
          void options.deleteFromNextCard(providerId).then((result) => {
            if (result.ok) {
            } else {
              console.warn(
                `[NextCard SW] Delete failed for ${providerId}:`,
                result.error,
              );
            }
          });
        }
        sendResponse({ ok: true });
        return true;
      }

      case "GET_STATUS": {
        const providerId = message.provider;
        if (!options.stateStore.isProviderId(providerId)) {
          sendResponse({ ok: false });
          return true;
        }
        sendResponse(options.stateStore.getPublicState(providerId));
        return true;
      }

      case "GET_ALL_STATUS":
        sendResponse(options.stateStore.getAllPublicStates());
        return true;

      case "LOGIN_STATE": {
        const providerId = message.provider;
        if (
          options.stateStore.isProviderId(providerId)
          && (
            message.state === "logged_in"
            || message.state === "logged_out"
            || message.state === "mfa_challenge"
            || message.state === "unknown"
          )
        ) {
          options.stateStore.setLoginState(providerId, message.state);
        }
        sendResponse({ ok: true });
        return true;
      }

      case "SIGN_IN_NEXTCARD":
        void options.startSignIn();
        sendResponse({ ok: true });
        return true;

      case "SIGN_OUT_NEXTCARD":
        options.onSignOut();
        void options.clearAuth().then(() => sendResponse({ ok: true }));
        return true;

      case "GET_AUTH_STATE":
        void options.getCachedAuth().then((auth) => sendResponse(auth));
        return true;

      case "RECORD_CONSENT":
        void options.recordConsent(message).then(() => sendResponse({ ok: true }));
        return true;

      case "GET_PROVIDER_STATUS": {
        const providerId = message.provider;
        if (!options.stateStore.isProviderId(providerId)) {
          sendResponse({ status: "idle" });
          return true;
        }
        sendResponse({ status: options.stateStore.states[providerId].status });
        return true;
      }

      case "PUSH_TO_NEXTCARD": {
        const providerId = message.provider;
        if (
          !options.stateStore.isProviderId(providerId)
          || !options.stateStore.states[providerId].data
        ) {
          sendResponse({ ok: false, error: "No data to push" });
          return true;
        }

        void options.pushToNextCard(
          providerId,
          options.stateStore.states[providerId].data,
        ).then((result) => sendResponse(result));
        return true;
      }

      // ── Amex Offers relay ──────────────────────────────
      case "AMEX_OFFERS_DISCOVER": {
        (async () => {
          try {
            // Find or open an Amex tab
            let tabId = amexOffersTabId;
            if (tabId) {
              try {
                const tab = await chrome.tabs.get(tabId);
                if (!tab.url?.includes("americanexpress.com")) tabId = null;
              } catch { tabId = null; }
            }
            if (!tabId) {
              const tab = await chrome.tabs.create({ url: "https://global.americanexpress.com/offers", active: true });
              tabId = tab.id!;
              amexOffersTabId = tabId;
              // Wait for page load + content script init
              await new Promise<void>((resolve) => {
                const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo) => {
                  if (id === tabId && info.status === "complete") {
                    chrome.tabs.onUpdated.removeListener(onUpdated);
                    resolve();
                  }
                };
                chrome.tabs.onUpdated.addListener(onUpdated);
                setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }, 30000);
              });
              await new Promise((r) => setTimeout(r, 3000));
            }

            chrome.tabs.sendMessage(tabId, { type: "AMEX_OFFERS_DISCOVER" }, (response) => {
              if (chrome.runtime.lastError) {
                sendResponse({ type: "AMEX_OFFERS_READY", cards: [], offerCount: 0, error: "content_script_unavailable" });
                return;
              }
              sendResponse(response);
            });
          } catch (e) {
            sendResponse({ type: "AMEX_OFFERS_READY", cards: [], offerCount: 0, error: String(e) });
          }
        })();
        return true;
      }

      case "AMEX_OFFERS_READ_PRODUCTS": {
        // Inject a script into MAIN world that reads digitalData.products
        // (Amex stores product data on Bootstrapper.digitalData, window.digitalData, or window.a_digitalData)
        (async () => {
          try {
            const tabs = await chrome.tabs.query({ url: "https://global.americanexpress.com/*" });
            const tabId = tabs[0]?.id;
            if (!tabId) { sendResponse({ products: null }); return; }

            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: () => {
                // Try multiple sources for products (same as CardPointers' products.js)
                let products = (window as unknown as Record<string, unknown>).Bootstrapper
                  && ((window as unknown as Record<string, Record<string, unknown>>).Bootstrapper.digitalData as Record<string, unknown> | undefined)?.products;
                if (!products) products = ((window as unknown as Record<string, Record<string, unknown>>).digitalData as Record<string, unknown> | undefined)?.products;
                if (!products) products = ((window as unknown as Record<string, Record<string, unknown>>).a_digitalData as Record<string, unknown> | undefined)?.products;
                return products ?? null;
              },
              args: [],
            });
            sendResponse({ products: results?.[0]?.result ?? null });
          } catch (e) {
            sendResponse({ products: null, error: String(e) });
          }
        })();
        return true;
      }

      case "AMEX_OFFERS_FETCH": {
        // Execute fetch in the page's MAIN world via chrome.scripting.executeScript.
        // This makes the request from the page's origin (same-site to functions.americanexpress.com),
        // so it carries all cookies and doesn't trigger CORS preflight.
        const fetchUrl = message.url as string;
        const fetchMethod = (message.method as string) ?? "GET";
        const fetchHeaders = (message.headers as Record<string, string>) ?? {};
        const fetchBody = (message.body as string) ?? undefined;

        (async () => {
          try {
            // Find the Amex tab
            const tabs = await chrome.tabs.query({ url: "https://global.americanexpress.com/*" });
            const tabId = tabs[0]?.id;
            if (!tabId) {
              sendResponse({ status: 0, data: null, error: "No Amex tab found" });
              return;
            }

            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: async (url: string, method: string, headers: Record<string, string>, body: string | undefined) => {
                try {
                  const resp = await fetch(url, {
                    method,
                    headers,
                    credentials: "include",
                    redirect: "follow",
                    referrerPolicy: "same-origin",
                    body: body ?? undefined,
                  });
                  let data = null;
                  try { data = await resp.json(); } catch { /* */ }
                  return { status: resp.status, data };
                } catch (e) {
                  return { status: 0, data: null, error: String(e) };
                }
              },
              args: [fetchUrl, fetchMethod, fetchHeaders, fetchBody ?? ""],
            });

            const result = results?.[0]?.result;
            sendResponse(result ?? { status: 0, data: null });
          } catch (e) {
            console.error("[NextCard SW] AMEX_OFFERS_FETCH error:", e);
            sendResponse({ status: 0, data: null, error: String(e) });
          }
        })();
        return true;
      }

      case "AMEX_OFFERS_ENROLL_ONE": {
        // Enroll a single offer via executeScript in MAIN world.
        const enrollCardId = message.cardId as string;
        const enrollOfferId = message.offerId as string;
        const enrollLocale = (message.locale as string) ?? "en-US";

        (async () => {
          try {
            const tabs = await chrome.tabs.query({ url: "https://global.americanexpress.com/*" });
            const tabId = tabs[0]?.id;
            if (!tabId) { sendResponse({ result: "failed" }); return; }

            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: async (cardId: string, offerId: string, locale: string) => {
                try {
                  const resp = await fetch("https://functions.americanexpress.com/CreateOffersHubEnrollment.web.v1", {
                    method: "POST",
                    headers: { "content-type": "application/json", accept: "application/json", "ce-source": "WEB" },
                    credentials: "include",
                    body: JSON.stringify({ accountNumberProxy: cardId, locale, offerId, requestType: "OFFERSHUB_ENROLLMENT", synchronizeOnly: false, enrollmentTrigger: "OFFERSHUB_TILE" }),
                  });
                  let json: Record<string, unknown> | null = null;
                  try { json = await resp.json(); } catch { /* */ }
                  const ok = resp.status === 200 && ((json?.status as Record<string, unknown>)?.purpose === "SUCCESS" || (json?.isEnrolled && json.isEnrolled !== "false"));
                  const dup = resp.status === 200 && json?.explanationCode === "PZN4107";
                  if (ok) return "added";
                  if (dup) return "skipped";
                  return "failed";
                } catch { return "failed"; }
              },
              args: [enrollCardId, enrollOfferId, enrollLocale],
            });

            sendResponse({ result: results?.[0]?.result ?? "failed" });
          } catch {
            sendResponse({ result: "failed" });
          }
        })();
        return true;
      }

      case "AMEX_OFFERS_RUN":
      case "AMEX_OFFERS_STOP": {
        if (amexOffersTabId) {
          chrome.tabs.sendMessage(amexOffersTabId, message, () => {
            if (chrome.runtime.lastError) { /* tab may be closed */ }
          });
        }
        sendResponse({ ok: true });
        return true;
      }

      case "AMEX_OFFERS_PROGRESS":
        sendResponse({ ok: true });
        return true;

      case "AMEX_OFFERS_COMPLETE":
        if (Array.isArray(message.enrolledOffers) && message.enrolledOffers.length > 0) {
          options.syncEnrolledOffers?.("amex", message);
        }
        sendResponse({ ok: true });
        return true;

      // ── Chase Offers (sync only — discovery/enrollment handled by content script) ──
      case "CHASE_OFFERS_COMPLETE":
        if (Array.isArray(message.enrolledOffers) && message.enrolledOffers.length > 0) {
          options.syncEnrolledOffers?.("chase", message);
        }
        sendResponse({ ok: true });
        return true;

      // ── Citi Offers ──────────────────────────────────
      case "CITI_OFFERS_FETCH": {
        const citiUrl = message.url as string;
        const citiMethod = (message.method as string) ?? "GET";
        const citiBody = (message.body as string) ?? null;

        (async () => {
          try {
            const tabs = await chrome.tabs.query({ url: "https://online.citi.com/*" });
            const tabId = tabs[0]?.id;
            if (!tabId) { sendResponse({ status: 0, data: null }); return; }

            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: async (url: string, method: string, body: string | null) => {
                // Build auth headers from cookies
                const getCookie = (name: string) => {
                  const match = document.cookie.match(new RegExp(`(?:^|;)\\s*${name}=([^;]*)`));
                  return match ? decodeURIComponent(match[1]) : "";
                };
                const headers: Record<string, string> = {
                  Accept: "application/json",
                  "Content-Type": "application/json",
                  TMXSessionId: getCookie("tmx_sessionid"),
                  appVersion: getCookie("appVersion"),
                  businessCode: getCookie("businessCode"),
                  channelId: getCookie("channelId"),
                  client_id: getCookie("client_id"),
                  countryCode: getCookie("countryCode"),
                  environmentID: "SuperMarioPROD",
                };
                try {
                  const resp = await fetch(url, {
                    method,
                    headers,
                    credentials: "include",
                    body: body ?? undefined,
                  });
                  let data = null;
                  try { data = await resp.json(); } catch { /* */ }
                  return { status: resp.status, data };
                } catch (e) {
                  return { status: 0, data: null, error: String(e) };
                }
              },
              args: [citiUrl, citiMethod, citiBody],
            });
            sendResponse(results?.[0]?.result ?? { status: 0, data: null });
          } catch (e) {
            sendResponse({ status: 0, data: null, error: String(e) });
          }
        })();
        return true;
      }

      case "CITI_OFFERS_PROGRESS":
        sendResponse({ ok: true });
        return true;

      case "CITI_OFFERS_COMPLETE":
        if (Array.isArray(message.enrolledOffers) && message.enrolledOffers.length > 0) {
          options.syncEnrolledOffers?.("citi", message);
        }
        sendResponse({ ok: true });
        return true;

      // ── Chase Bonus Registration ─────────────────────
      case "CHASE_BONUS_ENROLL": {
        const bonusCards = message.cards as string[];
        const bonusLastName = message.lastName as string;
        const bonusZip = message.zip as string;

        (async () => {
          try {
            // Get auth token
            const auth = await options.getCachedAuth();
            if (!auth?.token) {
              sendResponse({ error: "Not signed in to NextCard" });
              return;
            }

            const convexUrl = __CONVEX_SITE_URL__;

            // Enroll each card
            const results: Array<{ cardLast4: string; success: boolean; error?: string }> = [];

            for (const cardLast4 of bonusCards) {
              try {
                const resp = await fetch(`${convexUrl}/extension/bonus-enroll`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${auth.token}`,
                  },
                  body: JSON.stringify({
                    issuer: "chase",
                    credentials: {
                      type: "card",
                      cardLast4,
                      zipCode: bonusZip,
                      lastName: bonusLastName,
                    },
                  }),
                });

                const data = await resp.json();
                results.push({
                  cardLast4,
                  success: resp.ok,
                  error: resp.ok ? undefined : (data.error ?? "Failed"),
                });
              } catch (e) {
                results.push({ cardLast4, success: false, error: String(e) });
              }
            }

            sendResponse({ ok: true, results });
          } catch (e) {
            sendResponse({ error: String(e) });
          }
        })();
        return true;
      }

      default:
        sendResponse({ ok: true });
        return true;
    }
  };
}

let amexOffersTabId: number | null = null;

export function createExternalMessageRouter(options: {
  nextCardOrigin: string;
  setAuth: (auth: NextCardAuth) => Promise<void>;
  resetAuthCache: () => void;
  hydrateFromNextCard: () => Promise<void>;
}) {
  return (message: Record<string, unknown>, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    const origin = sender.url ? new URL(sender.url).origin : "";
    const allowedOrigins = [
      options.nextCardOrigin,
      "https://nextcard.com",
      "https://www.nextcard.com",
    ];
    if (!allowedOrigins.includes(origin)) {
      console.warn("[NextCard SW] Rejected external message from:", origin);
      sendResponse({ ok: false });
      return;
    }

    if (message.type === "AUTH_TOKEN" && typeof message.token === "string") {
      const auth: NextCardAuth = {
        token: message.token,
        name: typeof message.name === "string" ? message.name : null,
        email: typeof message.email === "string" ? message.email : null,
        signedInAt: new Date().toISOString(),
      };

      void options.setAuth(auth).then(async () => {
        options.resetAuthCache();
        sendResponse({ ok: true });

        if (sender.tab?.id) {
          const authTabId = sender.tab.id;
          chrome.tabs
            .update(authTabId, {
              url: `${options.nextCardOrigin}/get-started-extension`,
            })
            .catch(() => {
              chrome.tabs.create({
                url: `${options.nextCardOrigin}/get-started-extension`,
              });
            });
        }

        try {
          await options.hydrateFromNextCard();
        } catch (error) {
          console.warn("[NextCard SW] Hydrate after login failed:", error);
        }
      });
      return;
    }

    sendResponse({ ok: false });
  };
}
