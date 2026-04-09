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
              console.log(`[NextCard SW] Deleted ${providerId} from NextCard`);
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

      default:
        sendResponse({ ok: true });
        return true;
    }
  };
}

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
        console.log("[NextCard SW] Auth token received and stored");
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
