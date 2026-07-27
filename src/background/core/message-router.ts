import type { ExtensionProfile, NextCardAuth, ProviderId } from "../../lib/types";
import {
  isOfferIssuer,
  type OfferOperationCard,
  type OfferOperationPhase,
  type OfferSaveStatus,
} from "../../lib/offer-operation";
import type { ProviderDefinition, ProviderSyncStrategy } from "../../providers/provider-registry";
import type { OfferOperationStore } from "../offer-operation-store";
import type { OfferOperationCoordinator } from "../offer-operation-coordinator";
import {
  capOfferEnrollmentTotal,
  getOfferActivationUsage,
  recordOfferActivations,
  reserveOfferActivations,
} from "../../lib/offer-activation-usage";
import {
  AMEX_DEFAULT_RATE_LIMIT_DELAY_MS,
  classifyAmexEnrollmentResponse,
  evaluateAmexPrimaryResult,
  type AmexEnrollmentEndpoint,
  type AmexEnrollmentResult,
  type AmexPrimaryFallbackState,
} from "../amex-enrollment-policy";
import type { createRuntimeStateStore } from "./runtime-state";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

const AMEX_ENROLL_EXECUTION_TIMEOUT_MS = 65_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function executeAmexEnrollmentRequest(
  tabId: number,
  endpoint: AmexEnrollmentEndpoint,
  cardId: string,
  offerId: string,
  locale: string,
): Promise<AmexEnrollmentResult> {
  try {
    const injected = await withTimeout(chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (
        enrollmentEndpoint: AmexEnrollmentEndpoint,
        enrollmentCardId: string,
        enrollmentOfferId: string,
        enrollmentLocale: string,
      ) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        const userOffset = (() => {
          const offsetMinutes = -new Date().getTimezoneOffset();
          const sign = offsetMinutes >= 0 ? "+" : "-";
          const absolute = Math.abs(offsetMinutes);
          return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
        })();
        const requestDateTimeWithOffset = (() => {
          const date = new Date();
          const pad = (value: number) => String(value).padStart(2, "0");
          return `${date.getFullYear()}-${pad(date.getMonth() + 1)}_${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${userOffset}`;
        })();
        const request = enrollmentEndpoint === "offers_hub"
          ? {
              url: "https://functions.americanexpress.com/CreateOffersHubEnrollment.web.v1",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                "ce-source": "WEB",
              },
              body: {
                accountNumberProxy: enrollmentCardId,
                locale: enrollmentLocale,
                offerId: enrollmentOfferId,
                requestType: "OFFERSHUB_ENROLLMENT",
                offerUnencrypted: false,
                synchronizeOnly: false,
                enrollmentTrigger: "OFFERSHUB_TILE",
              },
            }
          : {
              url: "https://functions.americanexpress.com/CreateCardAccountOfferEnrollment.v1",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
                "ce-source": "offers.enroll",
              },
              body: {
                accountNumberProxy: enrollmentCardId,
                identifier: enrollmentOfferId,
                locale: enrollmentLocale,
                requestDateTimeWithOffset,
                userOffset,
              },
            };

        try {
          const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            cache: "no-store",
            credentials: "include",
            signal: controller.signal,
            body: JSON.stringify(request.body),
          });
          let body: Record<string, unknown> | null = null;
          try { body = await response.json() as Record<string, unknown>; } catch { /* non-JSON response */ }
          return {
            status: response.status,
            body,
            retryAfter: response.headers.get("retry-after"),
          };
        } catch (error) {
          return {
            status: 0,
            body: null,
            retryAfter: null,
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          clearTimeout(timeout);
        }
      },
      args: [endpoint, cardId, offerId, locale],
    }), AMEX_ENROLL_EXECUTION_TIMEOUT_MS, "Amex enrollment timed out before Chrome completed the request");

    const raw = injected?.[0]?.result as {
      status?: number;
      body?: Record<string, unknown> | null;
      retryAfter?: string | null;
      error?: string;
    } | undefined;
    return classifyAmexEnrollmentResponse({
      endpoint,
      status: raw?.status ?? 0,
      body: raw?.body ?? null,
      retryAfter: raw?.retryAfter,
      error: raw?.error,
    });
  } catch (error) {
    return classifyAmexEnrollmentResponse({
      endpoint,
      status: 0,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitAfterAmexRateLimit(result: AmexEnrollmentResult) {
  if (result.failureReason !== "rate_limited") return result;
  await delay(
    (result.retryAfterMs ?? AMEX_DEFAULT_RATE_LIMIT_DELAY_MS)
    + Math.floor(Math.random() * 101)
    + 50,
  );
  return result;
}

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

function isSyncStartInProgress(status: string) {
  return (
    status === "detecting_login"
    || status === "waiting_for_login"
    || status === "extracting"
  );
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
  isProviderLocked?: (providerId: ProviderId) => Promise<boolean>;
  getExtensionProfile?: () => Promise<ExtensionProfile | null>;
  refreshExtensionProfile?: () => Promise<ExtensionProfile | null>;
  openUpgrade?: () => Promise<void>;
  offerOperations: OfferOperationStore;
  offerCoordinator: OfferOperationCoordinator;
  syncEnrolledOffers?: (
    issuer: string,
    message: Record<string, unknown>,
  ) => void | OfferSaveStatus | Promise<void | OfferSaveStatus>;
  syncDetectedOffers?: (
    issuer: string,
    message: Record<string, unknown>,
  ) => void | OfferSaveStatus | Promise<void | OfferSaveStatus>;
}) {
  const amexEnrollmentFallbackRuns = new Map<string, AmexPrimaryFallbackState>();

  async function saveDetectedForRun(
    issuer: "chase" | "amex" | "citi" | "capitalone",
    runId: string,
    message: Record<string, unknown>,
  ) {
    await options.offerOperations.patchActiveRun(issuer, runId, {
      saveStatus: "saving",
    });
    let saveStatus: OfferSaveStatus = "saved";
    try {
      const result = await options.syncDetectedOffers?.(issuer, message);
      if (result === "queued_for_retry" || result === "failed") saveStatus = result;
    } catch {
      saveStatus = "failed";
    }
    const snapshot = await options.offerOperations.getSnapshot();
    const current = snapshot.active?.runId === runId
      ? snapshot.active
      : snapshot.history[issuer];
    if (current?.runId === runId && (current.saveStatus !== "failed" || saveStatus === "failed")) {
      await options.offerOperations.patchActiveRun(issuer, runId, { saveStatus });
    }
    return saveStatus;
  }

  return (message: Record<string, unknown>, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
    switch (message.type) {
      case "REQUEST_SYNC": {
        const providerId = message.provider;
        if (!options.stateStore.isProviderId(providerId)) {
          sendResponse({ ok: false, error: `Unknown provider: ${String(providerId)}` });
          return true;
        }

        void (async () => {
          if (
            options.stateStore.getRun(providerId)
            || isSyncStartInProgress(options.stateStore.states[providerId].status)
          ) {
            sendResponse({ ok: true, alreadyRunning: true });
            return;
          }

          if (await options.isProviderLocked?.(providerId)) {
            sendResponse({ ok: false, error: "selection_locked" });
            return;
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
              progressMessage: null,
            });
            console.error(
              `[NextCard SW] Unhandled ${providerId} sync error:`,
              error,
            );
          });

          const started = await options.stateStore.waitForSyncStart(providerId);
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
        })().catch((error) => {
          const errorMessage =
            error instanceof Error ? error.message : "Failed to start sync";
          sendResponse({ ok: false, error: errorMessage });
        });
        return true;
      }

      case "GET_EXTENSION_PROFILE":
        if (options.getExtensionProfile) {
          void options.getExtensionProfile().then((profile) => sendResponse(profile));
          return true;
        }
        sendResponse(null);
        return true;

      case "GET_OFFER_OPERATION_STATUS":
        void options.offerCoordinator.resume()
          .then(() => options.offerOperations.getSnapshot())
          .then((snapshot) => sendResponse(snapshot));
        return true;

      case "GET_OFFER_ACTIVATION_USAGE":
        void Promise.all([
          options.getCachedAuth(),
          options.getExtensionProfile?.() ?? Promise.resolve(null),
        ]).then(async ([auth, profile]) => {
          const usage = await getOfferActivationUsage(
            auth?.email,
            profile?.accountLevel === "pro",
          );
          sendResponse({ ...usage, accountLevel: profile?.accountLevel ?? "free" });
        });
        return true;

      case "RESERVE_OFFER_ACTIVATION": {
        const runId = typeof message.runId === "string" ? message.runId : "";
        const requested =
          typeof message.requested === "number" && Number.isFinite(message.requested)
            ? Math.max(0, Math.floor(message.requested))
            : 0;
        if (!runId || requested === 0) {
          sendResponse({ ok: false, error: "invalid_reservation" });
          return true;
        }
        void Promise.all([
          options.getCachedAuth(),
          options.getExtensionProfile?.() ?? Promise.resolve(null),
        ]).then(async ([auth, profile]) => {
          const reservation = await reserveOfferActivations(
            auth?.email,
            profile?.accountLevel === "pro",
            runId,
            requested,
          );
          sendResponse(
            reservation.ok
              ? reservation
              : {
                  ...reservation,
                  error: reservation.error ?? "quota_unavailable",
                },
          );
        });
        return true;
      }

      case "RELEASE_OFFER_ACTIVATION": {
        const runId = typeof message.runId === "string" ? message.runId : "";
        if (!runId) {
          sendResponse({ ok: false, error: "missing_run_id" });
          return true;
        }
        void options.getCachedAuth().then(async (auth) => {
          await recordOfferActivations(auth?.email, runId, 0).catch(() => {});
          sendResponse({ ok: true });
        });
        return true;
      }

      case "START_OFFER_CHECK": {
        if (!isOfferIssuer(message.issuer)) {
          sendResponse({ ok: false, error: "unsupported_issuer" });
          return true;
        }
        void options.offerCoordinator.startCheck(message.issuer).then((result) => sendResponse(result));
        return true;
      }

      case "REFRESH_OFFER_CHECK": {
        const runId = typeof message.runId === "string" ? message.runId : "";
        if (!runId) {
          sendResponse({ ok: false, error: "missing_run_id" });
          return true;
        }
        void options.offerCoordinator
          .refreshCheck(runId)
          .then((result) => sendResponse(result));
        return true;
      }

      case "PATCH_OFFER_OPERATION": {
        const runId = typeof message.runId === "string" ? message.runId : "";
        if (!runId) {
          sendResponse({ ok: false, error: "missing_run_id" });
          return true;
        }
        const validPhases: OfferOperationPhase[] = [
          "opening",
          "waiting_for_login",
          "checking",
          "ready_to_add",
          "adding",
          "completed",
          "cancelled",
          "interrupted",
          "failed",
        ];
        const validSaveStatuses: OfferSaveStatus[] = [
          "not_started",
          "saving",
          "saved",
          "queued_for_retry",
          "failed",
        ];
        const cards: OfferOperationCard[] | undefined = Array.isArray(message.cards)
          ? message.cards.flatMap((value) => {
              if (
                !value
                || typeof value !== "object"
                || typeof value.key !== "string"
                || typeof value.name !== "string"
              ) {
                return [];
              }
              const record = value as Record<string, unknown>;
              return [{
                key: record.key as string,
                name: record.name as string,
                lastDigits: typeof record.lastDigits === "string" ? record.lastDigits : null,
                availableCount:
                  typeof record.availableCount === "number" && record.availableCount >= 0
                    ? record.availableCount
                    : null,
                countStatus:
                  record.countStatus === "complete" || record.countStatus === "partial"
                    ? record.countStatus
                    : "unknown",
              } satisfies OfferOperationCard];
            })
          : undefined;
        const phase = validPhases.includes(message.phase as OfferOperationPhase)
          ? message.phase as OfferOperationPhase
          : undefined;
        const saveStatus = validSaveStatuses.includes(message.saveStatus as OfferSaveStatus)
          ? message.saveStatus as OfferSaveStatus
          : undefined;
        void options.offerOperations.patch(runId, {
          ...(phase ? { phase } : {}),
          ...(typeof message.ownedTabId === "number" || message.ownedTabId === null
            ? { ownedTabId: message.ownedTabId }
            : {}),
          ...(cards ? { cards } : {}),
          ...(Array.isArray(message.selectedCardKeys)
            ? { selectedCardKeys: message.selectedCardKeys.filter((key): key is string => typeof key === "string") }
            : {}),
          ...(typeof message.total === "number" || message.total === null ? { total: message.total } : {}),
          ...(typeof message.added === "number" ? { added: Math.max(0, message.added) } : {}),
          ...(typeof message.failed === "number" ? { failed: Math.max(0, message.failed) } : {}),
          ...(typeof message.remaining === "number" || message.remaining === null
            ? { remaining: message.remaining }
            : {}),
          ...(typeof message.error === "string" || message.error === null ? { error: message.error } : {}),
          ...(saveStatus ? { saveStatus } : {}),
        }).then((state) => sendResponse({ ok: Boolean(state), state }));
        return true;
      }

      case "START_OFFER_ENROLLMENT": {
        const runId = typeof message.runId === "string" ? message.runId : "";
        if (!runId) {
          sendResponse({ ok: false, error: "missing_run_id" });
          return true;
        }
        const selectedCardKeys = Array.isArray(message.selectedCardKeys)
          ? message.selectedCardKeys.filter((key): key is string => typeof key === "string")
          : [];
        const total = typeof message.total === "number" && message.total >= 0
          ? message.total
          : null;
        const addMatchingOffersAcrossCards =
          message.addMatchingOffersAcrossCards === true;
        void (async () => {
          const [auth, profile] = await Promise.all([
            options.getCachedAuth(),
            options.getExtensionProfile?.() ?? Promise.resolve(null),
          ]);
          const usage = await getOfferActivationUsage(
            auth?.email,
            profile?.accountLevel === "pro",
          );
          const requested =
            addMatchingOffersAcrossCards
              ? usage.remaining ?? total ?? 10_000
              : total ?? usage.remaining ?? 10_000;
          const reservation = await reserveOfferActivations(
            auth?.email,
            profile?.accountLevel === "pro",
            runId,
            requested,
          );
          const cappedTotal = capOfferEnrollmentTotal(total, reservation.granted);
          if (!reservation.ok || reservation.granted === 0 || cappedTotal === 0) {
            sendResponse({
              ...reservation,
              ok: false,
              accountLevel: profile?.accountLevel ?? "free",
              error: reservation.error ?? "quota_unavailable",
            });
            return;
          }
          const result = await options.offerCoordinator.startEnrollment(
            runId,
            selectedCardKeys,
            cappedTotal,
            {
              addMatchingOffersAcrossCards,
              maxOffers: reservation.granted,
            },
          );
          if (!result.ok) {
            await recordOfferActivations(auth?.email, runId, 0).catch(() => {});
          }
          sendResponse({
            ...result,
            granted: reservation.granted,
            requested,
          });
        })();
        return true;
      }

      case "CANCEL_OFFER_OPERATION":
        void options.offerCoordinator.cancel(
          typeof message.runId === "string" ? message.runId : undefined,
        ).then((state) => sendResponse({ ok: Boolean(state), state }));
        return true;

      case "REFRESH_EXTENSION_PROFILE":
        if (options.refreshExtensionProfile) {
          void options.refreshExtensionProfile().then((profile) => sendResponse(profile));
          return true;
        }
        sendResponse(null);
        return true;

      case "OPEN_UPGRADE":
        if (options.openUpgrade) {
          void options.openUpgrade()
            .then(() => sendResponse({ ok: true }))
            .catch((error) => {
              const errorMessage =
                error instanceof Error ? error.message : "Failed to open upgrade page";
              sendResponse({ ok: false, error: errorMessage });
            });
          return true;
        }
        sendResponse({ ok: false });
        return true;

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
            progressMessage: null,
            backendSyncStatus: null,
            backendSyncError: null,
            pendingBackendPush: false,
            lastBackendPushAttemptAt: null,
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
        void options.recordConsent(message).then(
          () => sendResponse({ ok: true }),
          () => sendResponse({ ok: false, error: "consent_record_failed" }),
        );
        return true;

      case "GET_PROVIDER_STATUS": {
        const providerId = message.provider;
        if (!options.stateStore.isProviderId(providerId)) {
          sendResponse({ status: "idle", progressMessage: null });
          return true;
        }
        const { status, progressMessage } = options.stateStore.states[providerId];
        sendResponse({ status, progressMessage });
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
            let tabId = sender.tab?.id ?? null;
            if (tabId) {
              const tab = await chrome.tabs.get(tabId).catch(() => null);
              if (!tab?.url?.includes("americanexpress.com")) tabId = null;
            }
            if (!tabId) {
              const tabs = await chrome.tabs.query({ url: "https://global.americanexpress.com/*" });
              tabId = tabs[0]?.id ?? null;
            }
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
            let tabId = sender.tab?.id ?? null;
            if (tabId) {
              const tab = await chrome.tabs.get(tabId).catch(() => null);
              if (!tab?.url?.includes("americanexpress.com")) tabId = null;
            }
            if (!tabId) {
              const tabs = await chrome.tabs.query({ url: "https://global.americanexpress.com/*" });
              tabId = tabs[0]?.id ?? null;
            }
            if (!tabId) {
              sendResponse({ status: 0, data: null, error: "No Amex tab found" });
              return;
            }

            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: async (url: string, method: string, headers: Record<string, string>, body: string | undefined) => {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 20000);
                try {
                  const resp = await fetch(url, {
                    method,
                    headers,
                    cache: "no-store",
                    credentials: "include",
                    redirect: "follow",
                    referrerPolicy: "same-origin",
                    body: body ?? undefined,
                    signal: controller.signal,
                  });
                  let data = null;
                  try { data = await resp.json(); } catch { /* */ }
                  return { status: resp.status, data };
                } catch (e) {
                  return { status: 0, data: null, error: String(e) };
                } finally {
                  clearTimeout(timeout);
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
        const enrollCardId = message.cardId as string;
        const enrollOfferId = message.offerId as string;
        const enrollLocale = (message.locale as string) ?? "en-US";
        const runId = typeof message.runId === "string" ? message.runId : "legacy";

        (async () => {
          try {
            let tabId = sender.tab?.id ?? null;
            if (tabId) {
              const tab = await chrome.tabs.get(tabId).catch(() => null);
              if (!tab?.url?.includes("americanexpress.com")) tabId = null;
            }
            if (!tabId) {
              const tabs = await chrome.tabs.query({ url: "https://global.americanexpress.com/*" });
              tabId = tabs[0]?.id ?? null;
            }
            if (!tabId) {
              sendResponse({ result: "failed", error: "No open Amex tab" });
              return;
            }

            const startedAt = Date.now();
            const fallbackState = amexEnrollmentFallbackRuns.get(runId) ?? {
              consecutiveFailures: 0,
              useOffersHubFallback: false,
            };
            let result: AmexEnrollmentResult;

            if (fallbackState.useOffersHubFallback) {
              result = await waitAfterAmexRateLimit(
                await executeAmexEnrollmentRequest(
                  tabId,
                  "offers_hub",
                  enrollCardId,
                  enrollOfferId,
                  enrollLocale,
                ),
              );
            } else {
              const primaryResult = await executeAmexEnrollmentRequest(
                tabId,
                "card_account",
                enrollCardId,
                enrollOfferId,
                enrollLocale,
              );
              const evaluated = evaluateAmexPrimaryResult(fallbackState, primaryResult);
              amexEnrollmentFallbackRuns.set(runId, evaluated.state);
              result = primaryResult;

              if (evaluated.fallbackNow) {
                const fallbackDelay =
                  primaryResult.retryAfterMs
                  ?? (primaryResult.failureReason === "network_or_cors"
                    ? AMEX_DEFAULT_RATE_LIMIT_DELAY_MS
                    : 0);
                if (fallbackDelay > 0) {
                  await delay(fallbackDelay + Math.floor(Math.random() * 101) + 50);
                }
                result = await waitAfterAmexRateLimit(
                  await executeAmexEnrollmentRequest(
                    tabId,
                    "offers_hub",
                    enrollCardId,
                    enrollOfferId,
                    enrollLocale,
                  ),
                );
              }
            }

            console.info("[NextCard SW] AMEX_OFFERS_ENROLL_ONE completed:", {
              elapsedMs: Date.now() - startedAt,
              result: result.result,
              endpoint: result.endpoint,
            });
            if (result.result === "failed" || result.result === "unknown") {
              console.warn("[NextCard SW] AMEX_OFFERS_ENROLL_ONE failed:", result);
            }
            sendResponse(result);
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error("[NextCard SW] AMEX_OFFERS_ENROLL_ONE error:", errorMessage);
            sendResponse({ result: "failed", error: errorMessage });
          }
        })();
        return true;
      }

      case "AMEX_OFFERS_ENROLL_GROUP": {
        const targets = Array.isArray(message.targets)
          ? message.targets.flatMap((target) => {
              if (!target || typeof target !== "object") return [];
              const record = target as Record<string, unknown>;
              return typeof record.cardId === "string" && typeof record.offerId === "string"
                && record.cardId.length > 0 && record.offerId.length > 0
                ? [{ cardId: record.cardId, offerId: record.offerId }]
                : [];
            })
          : [];
        const locale = typeof message.locale === "string" ? message.locale : "en-US";
        const useOffersHubFallback = message.useOffersHubFallback === true;
        const runId = typeof message.runId === "string" ? message.runId : "legacy-shared";

        if (targets.length === 0) {
          sendResponse({ results: [] });
          return true;
        }

        void (async () => {
          try {
            let tabId = sender.tab?.id ?? null;
            if (tabId) {
              const tab = await chrome.tabs.get(tabId).catch(() => null);
              if (!tab?.url?.includes("americanexpress.com")) tabId = null;
            }
            if (!tabId) {
              const tabs = await chrome.tabs.query({ url: "https://global.americanexpress.com/*" });
              tabId = tabs[0]?.id ?? null;
            }
            if (!tabId) {
              sendResponse({ results: targets.map(() => ({ result: "failed", error: "No open Amex tab" })) });
              return;
            }

            const fallbackState = amexEnrollmentFallbackRuns.get(runId) ?? {
              consecutiveFailures: 0,
              useOffersHubFallback: false,
            };
            const startWithFallback =
              useOffersHubFallback || fallbackState.useOffersHubFallback;

            if (startWithFallback) {
              const results = await Promise.all(targets.map((target) =>
                executeAmexEnrollmentRequest(
                  tabId,
                  "offers_hub",
                  target.cardId,
                  target.offerId,
                  locale,
                ).then(
                  waitAfterAmexRateLimit,
                )
              ));
              sendResponse({ results });
              return;
            }

            const primaryResults = await Promise.all(targets.map((target) =>
              executeAmexEnrollmentRequest(
                tabId,
                "card_account",
                target.cardId,
                target.offerId,
                locale,
              )
            ));
            let nextState = fallbackState;
            const fallbackTargets = new Set<number>();
            for (let index = 0; index < primaryResults.length; index += 1) {
              const evaluated = evaluateAmexPrimaryResult(
                nextState,
                primaryResults[index],
              );
              nextState = evaluated.state;
              if (evaluated.fallbackNow) fallbackTargets.add(index);
            }
            if (fallbackTargets.size > 0) {
              nextState = { ...nextState, useOffersHubFallback: true };
            }
            amexEnrollmentFallbackRuns.set(runId, nextState);

            const results = await Promise.all(primaryResults.map(async (result, index) => {
              if (!fallbackTargets.has(index)) return result;
              const fallbackDelay =
                result.retryAfterMs
                ?? (result.failureReason === "network_or_cors"
                  ? AMEX_DEFAULT_RATE_LIMIT_DELAY_MS
                  : 0);
              if (fallbackDelay > 0) {
                await delay(fallbackDelay + Math.floor(Math.random() * 101) + 50);
              }
              return executeAmexEnrollmentRequest(
                tabId,
                "offers_hub",
                targets[index].cardId,
                targets[index].offerId,
                locale,
              ).then(
                waitAfterAmexRateLimit,
              );
            }));
            sendResponse({ results });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Amex enrollment group failed";
            sendResponse({ results: targets.map(() => ({ result: "failed", error: errorMessage })) });
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
        if (typeof message.runId !== "string") {
          sendResponse({ ok: true, legacy: true });
          return true;
        }
        void options.offerOperations.patchActiveRun("amex", message.runId, {
          phase: "adding",
          added: typeof message.added === "number" ? Math.max(0, message.added) : 0,
          failed: typeof message.failed === "number" ? Math.max(0, message.failed) : 0,
          total: typeof message.total === "number" ? Math.max(0, message.total) : null,
          remaining:
            typeof message.total === "number"
              ? Math.max(
                  0,
                  message.total
                    - (typeof message.added === "number" ? message.added : 0)
                    - (typeof message.failed === "number" ? message.failed : 0),
                )
              : null,
        });
        sendResponse({ ok: true });
        return true;

      case "AMEX_OFFERS_COMPLETE": {
        if (typeof message.runId !== "string") {
          sendResponse({ ok: false, error: "missing_run_id" });
          return true;
        }
        amexEnrollmentFallbackRuns.delete(message.runId);
        const enrolledByCard = Array.isArray(message.enrolledByCard) ? message.enrolledByCard : null;
        void (async () => {
          const runId = message.runId as string;
          const auth = await options.getCachedAuth();
          await recordOfferActivations(
            auth?.email,
            runId,
            Math.max(
              0,
              (typeof message.added === "number" ? message.added : 0)
                - (typeof message.skipped === "number" ? message.skipped : 0),
            ),
          ).catch(() => {});
          const hasOffersToSave = enrolledByCard
            ? enrolledByCard.some((cardResult) => (
                cardResult
                && typeof cardResult === "object"
                && Array.isArray((cardResult as Record<string, unknown>).enrolledOffers)
                && ((cardResult as Record<string, unknown>).enrolledOffers as unknown[]).length > 0
              ))
            : Array.isArray(message.enrolledOffers) && message.enrolledOffers.length > 0;
          await options.offerOperations.patchActiveRun("amex", runId, {
            phase: message.cancelled === true ? "cancelled" : "completed",
            added: typeof message.added === "number" ? Math.max(0, message.added) : 0,
            failed: typeof message.failed === "number" ? Math.max(0, message.failed) : 0,
            cancelled: message.cancelled === true,
            error:
              message.sessionExpired === true
                ? "Sign in to Amex again to continue."
                : typeof message.lastError === "string"
                  ? message.lastError
                  : null,
            saveStatus: hasOffersToSave ? "saving" : "saved",
            remaining:
              typeof message.total === "number"
                ? Math.max(
                    0,
                    message.total
                      - (typeof message.added === "number" ? message.added : 0)
                      - (typeof message.failed === "number" ? message.failed : 0),
                  )
                : null,
          });

          let syncError: string | null = null;
          let completionSaveStatus: OfferSaveStatus = "saved";
          if (enrolledByCard) {
            for (const cardResult of enrolledByCard) {
              if (!cardResult || typeof cardResult !== "object") continue;
              const record = cardResult as Record<string, unknown>;
              if (!Array.isArray(record.enrolledOffers) || record.enrolledOffers.length === 0) continue;
              try {
                const result = await options.syncEnrolledOffers?.("amex", record);
                if (result === "queued_for_retry") completionSaveStatus = result;
                if (result === "failed") completionSaveStatus = result;
              } catch (error) {
                syncError = error instanceof Error ? error.message : "Could not save one or more verified Amex offers";
              }
            }
          } else if (Array.isArray(message.enrolledOffers) && message.enrolledOffers.length > 0) {
            try {
              const result = await options.syncEnrolledOffers?.("amex", message);
              if (result === "queued_for_retry" || result === "failed") {
                completionSaveStatus = result;
              }
            } catch (error) {
              syncError = error instanceof Error ? error.message : "Could not save verified Amex offers";
            }
          }
          chrome.runtime.sendMessage({
            type: "AMEX_OFFERS_SYNCED",
            runId: message.runId,
            added: message.added,
            skipped: message.skipped,
            failed: message.failed,
            unverified: message.unverified,
            cancelled: message.cancelled,
            sessionExpired: message.sessionExpired,
            lastError: message.lastError,
            rounds: message.rounds,
            multiCard: enrolledByCard !== null,
            syncError,
          }).catch(() => {});
          await options.offerOperations.patch(runId, {
            saveStatus: syncError ? "failed" : completionSaveStatus,
          });
          sendResponse({ ok: true });
        })();
        return true;
      }

      // ── Chase Offers (sync only — discovery/enrollment handled by content script) ──
      case "CHASE_OFFERS_PROGRESS":
        if (typeof message.runId !== "string") {
          sendResponse({ ok: true, legacy: true });
          return true;
        }
        void options.offerOperations.patchActiveRun("chase", message.runId, {
          phase: "adding",
          added: typeof message.added === "number" ? Math.max(0, message.added) : 0,
          total: typeof message.total === "number" ? Math.max(0, message.total) : null,
          remaining:
            typeof message.total === "number"
              ? Math.max(0, message.total - (typeof message.added === "number" ? message.added : 0))
              : null,
        });
        sendResponse({ ok: true });
        return true;

      case "CHASE_OFFERS_COMPLETE":
        void (async () => {
          const runId = typeof message.runId === "string" ? message.runId : null;
          if (runId) {
            const auth = await options.getCachedAuth();
            await recordOfferActivations(
              auth?.email,
              runId,
              typeof message.added === "number" ? message.added : 0,
            ).catch(() => {});
          }
          const hasOffersToSave =
            Array.isArray(message.enrolledOffers) && message.enrolledOffers.length > 0;
          if (runId) {
            await options.offerOperations.patchActiveRun("chase", runId, {
              phase: message.cancelled === true ? "cancelled" : "completed",
              added: typeof message.added === "number" ? Math.max(0, message.added) : 0,
              failed: typeof message.failed === "number" ? Math.max(0, message.failed) : 0,
              cancelled: message.cancelled === true,
              saveStatus: hasOffersToSave ? "saving" : "saved",
              remaining:
                typeof message.total === "number"
                  ? Math.max(
                      0,
                      message.total
                        - (typeof message.added === "number" ? message.added : 0)
                        - (typeof message.failed === "number" ? message.failed : 0),
                    )
                  : null,
            });
          }

          let saveStatus: OfferSaveStatus = "saved";
          if (hasOffersToSave) {
            try {
              const result = await options.syncEnrolledOffers?.("chase", message);
              if (result === "queued_for_retry" || result === "failed") saveStatus = result;
            } catch {
              saveStatus = "failed";
            }
          }
          if (runId) {
            await options.offerOperations.patch(runId, { saveStatus });
          }
          sendResponse({ ok: true, saveStatus });
        })();
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
        if (typeof message.runId !== "string") {
          sendResponse({ ok: true, legacy: true });
          return true;
        }
        void options.offerOperations.patchActiveRun("citi", message.runId, {
          phase: "adding",
          added: typeof message.added === "number" ? Math.max(0, message.added) : 0,
          total: typeof message.total === "number" ? Math.max(0, message.total) : null,
          remaining:
            typeof message.total === "number"
              ? Math.max(0, message.total - (typeof message.added === "number" ? message.added : 0))
              : null,
        });
        sendResponse({ ok: true });
        return true;

      case "CITI_OFFERS_COMPLETE":
        void (async () => {
          const runId = typeof message.runId === "string" ? message.runId : null;
          if (runId) {
            const auth = await options.getCachedAuth();
            await recordOfferActivations(
              auth?.email,
              runId,
              typeof message.added === "number" ? message.added : 0,
            ).catch(() => {});
          }
          const hasOffersToSave =
            Array.isArray(message.enrolledOffers) && message.enrolledOffers.length > 0;
          if (runId) {
            await options.offerOperations.patchActiveRun("citi", runId, {
              phase: message.cancelled === true ? "cancelled" : "completed",
              added: typeof message.added === "number" ? Math.max(0, message.added) : 0,
              failed: typeof message.failed === "number" ? Math.max(0, message.failed) : 0,
              cancelled: message.cancelled === true,
              saveStatus: hasOffersToSave ? "saving" : "saved",
              remaining:
                typeof message.total === "number"
                  ? Math.max(
                      0,
                      message.total
                        - (typeof message.added === "number" ? message.added : 0)
                        - (typeof message.failed === "number" ? message.failed : 0),
                    )
                  : null,
            });
          }

          let saveStatus: OfferSaveStatus = "saved";
          if (hasOffersToSave) {
            try {
              const result = await options.syncEnrolledOffers?.("citi", message);
              if (result === "queued_for_retry" || result === "failed") saveStatus = result;
            } catch {
              saveStatus = "failed";
            }
          }
          if (runId) {
            await options.offerOperations.patch(runId, { saveStatus });
          }
          sendResponse({ ok: true, saveStatus });
        })();
        return true;

      // ── Capital One Offers (shopping offers are detected, not enrolled) ──
      case "CAPITALONE_OFFERS_PROGRESS":
        if (typeof message.runId !== "string") {
          sendResponse({ ok: true, legacy: true });
          return true;
        }
        void options.offerOperations.patchActiveRun("capitalone", message.runId, {
          phase: "checking",
          total: typeof message.offersFound === "number"
            ? Math.max(0, message.offersFound)
            : null,
        });
        sendResponse({ ok: true });
        return true;

      case "CAPITALONE_OFFERS_COMPLETE":
        void (async () => {
          const runId = typeof message.runId === "string" ? message.runId : null;
          const hasOffersToSave =
            Array.isArray(message.detectedOffers) && message.detectedOffers.length > 0;
          if (runId) {
            await options.offerOperations.patchActiveRun("capitalone", runId, {
              phase: "completed",
              added: 0,
              total:
                typeof message.synced === "number"
                  ? Math.max(0, message.synced)
                  : typeof message.offersFound === "number"
                    ? Math.max(0, message.offersFound)
                    : null,
              saveStatus: hasOffersToSave ? "saving" : "saved",
            });
          }

          let saveStatus: OfferSaveStatus = "saved";
          try {
            if (hasOffersToSave) {
              const result = await options.syncDetectedOffers?.("capitalone", message);
              if (result === "queued_for_retry" || result === "failed") saveStatus = result;
            }
          } catch {
            saveStatus = "failed";
          }
          if (runId) {
            await options.offerOperations.patch(runId, { saveStatus });
          }
          sendResponse({ ok: true, saveStatus });
        })();
        return true;

      // ── Detected Offers (all providers) ───────────────
      case "CHASE_OFFERS_DETECTED":
        if (
          typeof message.runId === "string"
          && Array.isArray(message.detectedOffers)
          && message.detectedOffers.length > 0
        ) {
          void saveDetectedForRun("chase", message.runId, message)
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        if (Array.isArray(message.detectedOffers) && message.detectedOffers.length > 0) {
          void Promise.resolve(options.syncDetectedOffers?.("chase", message))
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        sendResponse({ ok: true });
        return true;

      case "AMEX_OFFERS_DETECTED":
        if (
          typeof message.runId === "string"
          && Array.isArray(message.detectedOffers) &&
          (message.detectedOffers.length > 0 || message.snapshotComplete === true)
        ) {
          void saveDetectedForRun("amex", message.runId, message)
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        if (
          Array.isArray(message.detectedOffers)
          && (message.detectedOffers.length > 0 || message.snapshotComplete === true)
        ) {
          void Promise.resolve(options.syncDetectedOffers?.("amex", message))
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        sendResponse({ ok: true });
        return true;

      case "CITI_OFFERS_DETECTED":
        if (
          typeof message.runId === "string"
          && Array.isArray(message.detectedOffers)
          && message.detectedOffers.length > 0
        ) {
          void saveDetectedForRun("citi", message.runId, message)
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        if (Array.isArray(message.detectedOffers) && message.detectedOffers.length > 0) {
          void Promise.resolve(options.syncDetectedOffers?.("citi", message))
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        sendResponse({ ok: true });
        return true;

      case "CAPITALONE_OFFERS_DETECTED":
        if (
          typeof message.runId === "string"
          && Array.isArray(message.detectedOffers)
          && message.detectedOffers.length > 0
        ) {
          void saveDetectedForRun("capitalone", message.runId, message)
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        if (Array.isArray(message.detectedOffers) && message.detectedOffers.length > 0) {
          void Promise.resolve(options.syncDetectedOffers?.("capitalone", message))
            .then((saveStatus) => sendResponse({ ok: saveStatus !== "failed", saveStatus }));
          return true;
        }
        sendResponse({ ok: true });
        return true;

      // ── Open Side Panel to Tools Tab ────────────────
      case "OPEN_TOOLS_TAB":
        chrome.storage.local.set({
          pendingDestination: "offers",
          pendingTab: "tools",
        });
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#d4943a" });
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
  pullOfferUrlCache: () => Promise<void>;
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

      sendResponse({ ok: true });

      void options.setAuth(auth).then(async () => {
        options.resetAuthCache();

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

        try {
          await options.pullOfferUrlCache();
        } catch (error) {
          console.warn("[NextCard SW] Offer cache pull after login failed:", error);
        }
      });
      return;
    }

    sendResponse({ ok: false });
  };
}
