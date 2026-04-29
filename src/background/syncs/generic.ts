import type {
  AALoyaltyData,
  AmexLoyaltyData,
  AtmosLoyaltyData,
  CapitalOneLoyaltyData,
  DeltaLoyaltyData,
  FrontierLoyaltyData,
  HiltonLoyaltyData,
  MarriottLoyaltyData,
  ProviderId,
  SouthwestLoyaltyData,
  UnitedLoyaltyData,
} from "../../lib/types";
import type { ProviderDefinition } from "../../providers/provider-registry";
import type { createRuntimeStateStore } from "../core/runtime-state";
import {
  checkIfLoginPage,
  navigateAndWait,
  recoverFromStall,
  tabClosedSignal,
  triggerExtraction,
  waitForTabLoad,
  getTabLoginState,
} from "../core/tab-utils";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

interface GenericSyncDeps {
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  extensionNavigatingTabs: Set<number>;
  isProviderAttemptMessage: (
    message: Record<string, unknown>,
    providerId: ProviderId,
    attemptId: string,
    type?: string,
  ) => boolean;
  pushToNextCard: (
    providerId: ProviderId,
    data: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
}

const ATMOS_REWARDS_URL =
  "https://www.alaskaair.com/atmosrewards/account/rewards";
const ATMOS_DISCOUNTS_URL =
  "https://www.alaskaair.com/atmosrewards/account/wallet?section=discounts";

export function createGenericSyncHandlers(options: GenericSyncDeps) {
  function waitForMarriottLoginAndExtract(
    attemptId: string,
    tabId: number,
    timeoutMs = 120000,
  ): Promise<Record<string, unknown>> {
    const providerId = "marriott";
    const config = options.providerRegistry[providerId];
    const closed = tabClosedSignal(tabId);
    const cancelled = options.stateStore.createRunCancelSignal(providerId, attemptId);

    return Promise.race([
      closed.promise,
      cancelled.promise,
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for Marriott login"));
        }, timeoutMs);

        function onTabUpdated(
          updatedTabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          tab: chrome.tabs.Tab,
        ) {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return;

          const url = tab.url ?? "";
          const isOtpChallenge =
            url.includes("send-otp-challenge") || url.includes("otp-challenge");
          const isAccountPage =
            (url.includes("/loyalty/myAccount") || url.includes("/mybonvoy/"))
            && !isOtpChallenge;
          const isActivityPage = url.includes("/loyalty/myAccount/activity");

          if (isOtpChallenge) {
            options.stateStore.updateProvider(providerId, {
              status: "waiting_for_login",
            });
            return;
          }

          if (isAccountPage) {
            if (isActivityPage) {
              setTimeout(() => {
                void triggerExtraction({
                  providerId,
                  attemptId,
                  tabId,
                  assertRunActive: options.stateStore.assertRunActive,
                }).catch(() => {
                  console.warn(
                    "[NextCard SW] Failed to trigger Marriott extraction after login",
                  );
                });
              }, 2000);
            } else {
              void navigateAndWait(
                tabId,
                config.syncUrl,
                options.extensionNavigatingTabs,
              ).then(() => {
                void triggerExtraction({
                  providerId,
                  attemptId,
                  tabId,
                  assertRunActive: options.stateStore.assertRunActive,
                }).catch(() => {
                  console.warn(
                    "[NextCard SW] Failed to trigger Marriott extraction after redirect",
                  );
                });
              });
            }
            options.stateStore.updateProvider(providerId, { status: "extracting" });
          }
        }

        function onMessage(
          message: Record<string, unknown>,
          _sender: chrome.runtime.MessageSender,
          sendResponse: (response?: unknown) => void,
        ) {
          if (
            options.isProviderAttemptMessage(
              message,
              providerId,
              attemptId,
              "EXTRACTION_DONE",
            )
          ) {
            cleanup();
            sendResponse({ ok: true });
            resolve(message);
            return true;
          }
          if (
            options.isProviderAttemptMessage(
              message,
              providerId,
              attemptId,
              "LOGIN_STATE",
            )
            && message.state === "logged_in"
          ) {
            options.stateStore.updateProvider(providerId, { status: "extracting" });
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          closed.cancel();
          cancelled.cancel();
          chrome.tabs.onUpdated.removeListener(onTabUpdated);
          chrome.runtime.onMessage.removeListener(onMessage);
        }

        chrome.tabs.onUpdated.addListener(onTabUpdated);
        chrome.runtime.onMessage.addListener(onMessage);
      }),
    ]);
  }

  function waitForAtmosMessage(
    attemptId: string,
    messageType: string,
    timeoutMs = 60000,
  ) {
    let cleanup = () => {};
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${messageType}`));
      }, timeoutMs);

      function listener(
        message: Record<string, unknown>,
        _sender: chrome.runtime.MessageSender,
        sendResponse: (response?: unknown) => void,
      ) {
        if (
          options.isProviderAttemptMessage(message, "atmos", attemptId, messageType)
        ) {
          cleanup();
          sendResponse({ ok: true });
          resolve(message);
          return true;
        }
        if (
          options.isProviderAttemptMessage(
            message,
            "atmos",
            attemptId,
            "STATUS_UPDATE",
          )
          && message.status === "waiting_for_login"
        ) {
          cleanup();
          sendResponse({ ok: true });
          resolve(message);
          return true;
        }
      }

      cleanup = () => {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
      };

      chrome.runtime.onMessage.addListener(listener);
    });

    return { promise, cancel: () => cleanup() };
  }

  function waitForAtmosLoginAndExtract(
    attemptId: string,
    tabId: number,
    timeoutMs = 120000,
  ): Promise<Record<string, unknown>> {
    const closed = tabClosedSignal(tabId);
    const cancelled = options.stateStore.createRunCancelSignal("atmos", attemptId);

    return Promise.race([
      closed.promise,
      cancelled.promise,
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for Atmos login"));
        }, timeoutMs);

        function onTabUpdated(
          updatedTabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          tab: chrome.tabs.Tab,
        ) {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return;

          const url = tab.url ?? "";
          const isAccountPage =
            url.includes("/atmosrewards/") && !url.includes("/login");

          if (isAccountPage) {
            void triggerExtraction({
              providerId: "atmos",
              attemptId,
              tabId,
              assertRunActive: options.stateStore.assertRunActive,
              retries: 6,
              retryDelayMs: 5000,
            }).catch(() => {
              console.warn(
                "[NextCard SW] Failed to trigger Atmos extraction after login",
              );
            });
            options.stateStore.updateProvider("atmos", { status: "extracting" });
          }
        }

        function onMessage(
          message: Record<string, unknown>,
          _sender: chrome.runtime.MessageSender,
          sendResponse: (response?: unknown) => void,
        ) {
          if (
            options.isProviderAttemptMessage(
              message,
              "atmos",
              attemptId,
              "ATMOS_OVERVIEW_DONE",
            )
          ) {
            cleanup();
            sendResponse({ ok: true });
            resolve(message);
            return true;
          }
          if (
            options.isProviderAttemptMessage(
              message,
              "atmos",
              attemptId,
              "LOGIN_STATE",
            )
            && message.state === "logged_in"
          ) {
            options.stateStore.updateProvider("atmos", { status: "extracting" });
            void triggerExtraction({
              providerId: "atmos",
              attemptId,
              tabId,
              assertRunActive: options.stateStore.assertRunActive,
              retries: 6,
              retryDelayMs: 5000,
            }).catch(() => {});
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          closed.cancel();
          cancelled.cancel();
          chrome.tabs.onUpdated.removeListener(onTabUpdated);
          chrome.runtime.onMessage.removeListener(onMessage);
        }

        chrome.tabs.onUpdated.addListener(onTabUpdated);
        chrome.runtime.onMessage.addListener(onMessage);

        chrome.tabs
          .get(tabId)
          .then((tab) => {
            if (tab.status === "complete") {
              onTabUpdated(tabId, { status: "complete" }, tab);
            }
          })
          .catch(() => {});
      }),
    ]);
  }

  async function startAtmosSync() {
    const attemptId = options.stateStore.beginSyncRun("atmos").attemptId;
    const config = options.providerRegistry.atmos;
    options.stateStore.updateProvider("atmos", {
      status: "detecting_login",
      error: null,
    });

    try {
      const tab = await chrome.tabs.create({ url: config.syncUrl, active: true });
      await waitForTabLoad(tab.id!, 30000);

      const tabId = tab.id;
      if (!tabId) throw new Error("Could not create tab");
      options.stateStore.recordRunTab("atmos", attemptId, tabId, { owned: true });
      options.stateStore.updateProvider("atmos", { status: "extracting" });

      let overview = waitForAtmosMessage(attemptId, "ATMOS_OVERVIEW_DONE");

      if (await checkIfLoginPage(tabId)) {
        overview.cancel();
        options.stateStore.updateProvider("atmos", { status: "waiting_for_login" });
        const loginResult = await waitForAtmosLoginAndExtract(attemptId, tabId);
        overview = waitForAtmosMessage(attemptId, "ATMOS_OVERVIEW_DONE");
        if (loginResult.type !== "ATMOS_OVERVIEW_DONE") {
          await triggerExtraction({
            providerId: "atmos",
            attemptId,
            tabId,
            assertRunActive: options.stateStore.assertRunActive,
          });
        }
      } else {
        await triggerExtraction({
          providerId: "atmos",
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
          retries: 6,
          retryDelayMs: 5000,
        });
      }

      let overviewResult: Record<string, unknown>;
      try {
        overviewResult = await overview.promise;
      } catch {
        overview.cancel();
        const recovery = await recoverFromStall({
          providerId: "atmos",
          attemptId,
          tabId,
          isFirstPhase: true,
          assertRunActive: options.stateStore.assertRunActive,
          triggerExtraction: () =>
            triggerExtraction({
              providerId: "atmos",
              attemptId,
              tabId,
              assertRunActive: options.stateStore.assertRunActive,
            }),
        });
        if (recovery === "login_needed") {
          options.stateStore.updateProvider("atmos", { status: "waiting_for_login" });
          overviewResult = await waitForAtmosLoginAndExtract(attemptId, tabId);
        } else {
          overview = waitForAtmosMessage(attemptId, "ATMOS_OVERVIEW_DONE");
          overviewResult = await overview.promise;
        }
      }

      if (
        overviewResult.type === "STATUS_UPDATE"
        && overviewResult.status === "waiting_for_login"
      ) {
        options.stateStore.updateProvider("atmos", { status: "waiting_for_login" });
        const loginResult = await waitForAtmosLoginAndExtract(attemptId, tabId);
        Object.assign(overviewResult, loginResult);
      }

      options.stateStore.assertRunActive("atmos", attemptId);
      const overviewData = (overviewResult.data ?? {}) as Partial<AtmosLoyaltyData>;

      await navigateAndWait(
        tabId,
        ATMOS_REWARDS_URL,
        options.extensionNavigatingTabs,
      );
      options.stateStore.assertRunActive("atmos", attemptId);
      let rewardsMessage = waitForAtmosMessage(attemptId, "ATMOS_REWARDS_DONE");
      await triggerExtraction({
        providerId: "atmos",
        attemptId,
        tabId,
        assertRunActive: options.stateStore.assertRunActive,
      });
      let rewardsResult: Record<string, unknown>;
      try {
        rewardsResult = await rewardsMessage.promise;
      } catch {
        rewardsMessage.cancel();
        await triggerExtraction({
          providerId: "atmos",
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
        });
        rewardsMessage = waitForAtmosMessage(attemptId, "ATMOS_REWARDS_DONE");
        rewardsResult = await rewardsMessage.promise;
      }

      options.stateStore.assertRunActive("atmos", attemptId);
      const rewards = (rewardsResult.rewards ?? []) as AtmosLoyaltyData["rewards"];

      options.stateStore.assertRunActive("atmos", attemptId);
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (url: string) => {
          window.location.href = url;
        },
        args: [ATMOS_DISCOUNTS_URL],
      });
      await waitForTabLoad(tabId, 30000);
      options.stateStore.assertRunActive("atmos", attemptId);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      let discountsMessage = waitForAtmosMessage(
        attemptId,
        "ATMOS_DISCOUNTS_DONE",
        120000,
      );
      await triggerExtraction({
        providerId: "atmos",
        attemptId,
        tabId,
        assertRunActive: options.stateStore.assertRunActive,
      });
      let discountsResult: Record<string, unknown>;
      try {
        discountsResult = await discountsMessage.promise;
      } catch {
        discountsMessage.cancel();
        await triggerExtraction({
          providerId: "atmos",
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
        });
        discountsMessage = waitForAtmosMessage(
          attemptId,
          "ATMOS_DISCOUNTS_DONE",
          120000,
        );
        discountsResult = await discountsMessage.promise;
      }

      options.stateStore.assertRunActive("atmos", attemptId);
      const discounts =
        (discountsResult.discounts ?? []) as AtmosLoyaltyData["discounts"];

      options.stateStore.assertRunActive("atmos", attemptId);
      chrome.tabs.update(tabId, { url: options.providerRegistry.atmos.syncUrl });

      const fullData: AtmosLoyaltyData = {
        availablePoints: overviewData.availablePoints ?? null,
        statusPoints: overviewData.statusPoints ?? null,
        statusLevel: overviewData.statusLevel ?? null,
        memberName: overviewData.memberName ?? null,
        memberNumber: overviewData.memberNumber ?? null,
        rewards,
        discounts,
      };

      options.stateStore.assertRunActive("atmos", attemptId);
      options.stateStore.updateProvider("atmos", {
        status: "done",
        data: fullData,
        error: null,
        lastSyncedAt: new Date().toISOString(),
      });

      options.stateStore.assertRunActive("atmos", attemptId);
      void options.pushToNextCard("atmos", fullData).then((result) => {
        if (result.ok) {
        } else {
          console.warn("[NextCard SW] Atmos push failed:", result.error);
        }
      });
      options.stateStore.finishSyncRun("atmos", attemptId);
    } catch (error) {
      if (options.stateStore.wasRunCancelled("atmos", attemptId, error)) {
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : "Sync failed";
      options.stateStore.updateProvider("atmos", {
        status: "error",
        error: errorMessage,
      });
      console.error("[NextCard SW] Atmos sync error:", error);
    }
  }

  function waitForGenericLoginAndExtract(
    providerId: ProviderId,
    attemptId: string,
    tabId: number,
    timeoutMs = 120000,
  ): Promise<Record<string, unknown>> {
    const definition = options.providerRegistry[providerId];
    const accountPattern = new RegExp(
      definition.accountUrlPattern.replace(/\*/g, ".*"),
    );
    const closed = tabClosedSignal(tabId);
    const cancelled = options.stateStore.createRunCancelSignal(providerId, attemptId);

    return Promise.race([
      closed.promise,
      cancelled.promise,
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${definition.name} login`));
        }, timeoutMs);
        let extractionTriggered = false;
        let loginCheckInFlight = false;
        let redirectTimeout: ReturnType<typeof setTimeout> | null = null;

        function handleAccountArrival(arrivalTabId: number) {
          if (extractionTriggered) return;
          extractionTriggered = true;
          options.extensionNavigatingTabs.delete(arrivalTabId);
          options.stateStore.recordRunTab(providerId, attemptId, arrivalTabId, {
            owned: arrivalTabId === tabId,
          });
          options.stateStore.updateProvider(providerId, { status: "extracting" });
          setTimeout(() => {
            void triggerExtraction({
              providerId,
              attemptId,
              tabId: arrivalTabId,
              assertRunActive: options.stateStore.assertRunActive,
            }).catch(() => {
              console.warn(
                `[NextCard SW] Failed to trigger ${definition.name} extraction after login`,
              );
            });
          }, 3000);
        }

        const tabUrlBase = definition.tabUrlPattern.replace(/\*/g, "");
        let redirectPending = false;

        async function onTabUpdated(
          updatedTabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          tab: chrome.tabs.Tab,
        ) {
          if (changeInfo.status !== "complete") return;
          const url = tab.url ?? "";
          if (!definition.magicLinkLogin && updatedTabId !== tabId) return;
          if (
            definition.magicLinkLogin
            && updatedTabId !== tabId
            && !url.startsWith(tabUrlBase)
          ) {
            return;
          }

          if (accountPattern.test(url)) {
            if (loginCheckInFlight || extractionTriggered) return;
            loginCheckInFlight = true;
            try {
              const loginState = await getTabLoginState(updatedTabId);
              if (loginState === "logged_in") {
                redirectPending = false;
                handleAccountArrival(updatedTabId);
              } else {
                options.stateStore.updateProvider(providerId, {
                  status: "waiting_for_login",
                });
              }
            } catch {
              options.stateStore.updateProvider(providerId, {
                status: "waiting_for_login",
              });
            } finally {
              loginCheckInFlight = false;
            }
          } else if (
            definition.accountUrl
            && !redirectPending
            && !url.includes("signin")
            && !url.includes("login")
            && !url.includes("sign-in")
            && !url.includes("verify")
            && !url.includes("challenge")
          ) {
            if (definition.magicLinkLogin || updatedTabId === tabId) {
              redirectPending = true;
              redirectTimeout = setTimeout(() => {
                try {
                  options.stateStore.assertRunActive(providerId, attemptId);
                  options.extensionNavigatingTabs.add(updatedTabId);
                  chrome.tabs.update(updatedTabId, { url: definition.accountUrl });
                } catch {
                  redirectPending = false;
                } finally {
                  redirectTimeout = null;
                }
              }, 3000);
            }
          }
        }

        function onMessage(
          message: Record<string, unknown>,
          sender: chrome.runtime.MessageSender,
          sendResponse: (response?: unknown) => void,
        ) {
          if (message.type === "EXTRACTION_DONE" && message.provider === providerId) {
            if (
              !options.isProviderAttemptMessage(
                message,
                providerId,
                attemptId,
                "EXTRACTION_DONE",
              )
            ) {
              return;
            }
            cleanup();
            sendResponse({ ok: true });
            resolve(message);
            return true;
          }
          const senderTabId = sender.tab?.id;
          const senderUrl = sender.url ?? sender.tab?.url ?? "";
          const isExpectedTab =
            senderTabId === tabId
            || (
              definition.magicLinkLogin
              && senderTabId != null
              && senderUrl.startsWith(tabUrlBase)
            );
          const isCurrentAttemptLoginState =
            options.isProviderAttemptMessage(
              message,
              providerId,
              attemptId,
              "LOGIN_STATE",
            );
          const isInitialPageLoginState =
            message.type === "LOGIN_STATE"
            && message.provider === providerId
            && message.state === "logged_in"
            && message.attemptId == null
            && isExpectedTab;

          if (
            message.state === "logged_in"
            && (isCurrentAttemptLoginState || isInitialPageLoginState)
          ) {
            handleAccountArrival(senderTabId ?? tabId);
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          if (redirectTimeout) {
            clearTimeout(redirectTimeout);
            redirectTimeout = null;
          }
          closed.cancel();
          cancelled.cancel();
          chrome.tabs.onUpdated.removeListener(onTabUpdated);
          chrome.runtime.onMessage.removeListener(onMessage);
        }

        chrome.tabs.onUpdated.addListener(onTabUpdated);
        chrome.runtime.onMessage.addListener(onMessage);

        chrome.tabs
          .get(tabId)
          .then((tab) => {
            if (tab.status === "complete") {
              void onTabUpdated(tabId, { status: "complete" }, tab);
            }
          })
          .catch(() => {});
      }),
    ]);
  }

  async function startSync(providerId: ProviderId) {
    const definition = options.providerRegistry[providerId];
    const attemptId = options.stateStore.beginSyncRun(providerId).attemptId;
    options.stateStore.updateProvider(providerId, {
      status: "detecting_login",
      error: null,
    });

    try {
      const tab = await chrome.tabs.create({ url: definition.syncUrl, active: true });
      const tabId = tab.id;
      if (!tabId) throw new Error("Could not create tab");
      await waitForTabLoad(tabId, 30000);
      options.stateStore.recordRunTab(providerId, attemptId, tabId, { owned: true });

      let currentTab = await chrome.tabs.get(tabId);
      let landingUrl = currentTab.url ?? "";

      // Some providers (e.g. Discover) do a client-side JS redirect after page load
      // when the user is already logged in. Wait briefly and re-check the URL.
      if (landingUrl.match(/sign.?in|login/i) && definition.accountUrl) {
        await new Promise((r) => setTimeout(r, 3000));
        currentTab = await chrome.tabs.get(tabId);
        landingUrl = currentTab.url ?? "";
      }

      // If syncUrl was a sign-in page but we landed elsewhere (user already logged in),
      // navigate to the account page so the content script can extract data.
      if (
        definition.accountUrl
        && definition.syncUrl.match(/sign.?in|login/i)
        && !landingUrl.match(/sign.?in|login/i)
        && !landingUrl.includes("send-otp-challenge")
        && !landingUrl.includes("otp-challenge")
      ) {
        const accountPattern = new RegExp(definition.accountUrlPattern.replace(/\*/g, ".*"));
        if (!accountPattern.test(landingUrl)) {
          await navigateAndWait(tabId, definition.accountUrl, options.extensionNavigatingTabs);
          currentTab = await chrome.tabs.get(tabId);
          landingUrl = currentTab.url ?? "";
        }
      }

      if (
        landingUrl.includes("send-otp-challenge")
        || landingUrl.includes("otp-challenge")
      ) {
        options.stateStore.updateProvider(providerId, {
          status: "waiting_for_login",
        });

        const result = providerId === "marriott"
          ? await waitForMarriottLoginAndExtract(attemptId, tabId)
          : await waitForGenericLoginAndExtract(providerId, attemptId, tabId);
        if (result.type === "EXTRACTION_DONE" && result.data) {
          const data =
            result.data as MarriottLoyaltyData
            | AALoyaltyData
            | DeltaLoyaltyData
            | UnitedLoyaltyData
            | SouthwestLoyaltyData
            | AmexLoyaltyData
            | CapitalOneLoyaltyData
            | HiltonLoyaltyData
            | FrontierLoyaltyData;
          options.stateStore.assertRunActive(providerId, attemptId);
          options.stateStore.updateProvider(providerId, {
            status: "done",
            data,
            error: null,
            lastSyncedAt: new Date().toISOString(),
          });
          options.stateStore.assertRunActive(providerId, attemptId);
          void options.pushToNextCard(providerId, data).then((result) => {
            if (result.ok) {
            } else {
              console.warn(
                `[NextCard SW] ${definition.name} push failed:`,
                result.error,
              );
            }
          });
          options.stateStore.finishSyncRun(providerId, attemptId);
        } else {
          options.stateStore.updateProvider(providerId, {
            status: "error",
            error: "No data extracted",
          });
        }
        return;
      }

      // If we opened the sign-in page but landed elsewhere (user already logged in),
      // go directly to the account page.
      const isOnSignIn = landingUrl.match(/sign.?in|login/i);
      const accountPattern = new RegExp(definition.accountUrlPattern.replace(/\*/g, ".*"));
      const isOnAccount = accountPattern.test(landingUrl);

      if (!isOnSignIn && !isOnAccount && definition.accountUrl) {
        await navigateAndWait(tabId, definition.accountUrl, options.extensionNavigatingTabs);
      }

      options.stateStore.updateProvider(providerId, { status: "detecting_login" });

      const firstMessage = await new Promise<Record<string, unknown>>((resolve) => {
        const timeout = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({
            type: "ERROR",
            provider: providerId,
            error: "Extraction timed out",
          });
        }, 60000);

        function listener(
          message: Record<string, unknown>,
          _sender: chrome.runtime.MessageSender,
          sendResponse: (response?: unknown) => void,
        ) {
          if (
            (message.type === "EXTRACTION_DONE" || message.type === "STATUS_UPDATE")
            && options.isProviderAttemptMessage(message, providerId, attemptId)
          ) {
            chrome.runtime.onMessage.removeListener(listener);
            clearTimeout(timeout);
            sendResponse({ ok: true });
            resolve(message);
            return true;
          }
        }

        chrome.runtime.onMessage.addListener(listener);

        void triggerExtraction({
          providerId,
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
        }).catch(() => {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timeout);
          resolve({
            type: "ERROR",
            provider: providerId,
            error: "Content script not available",
          });
        });
      });

      let result: Record<string, unknown>;
      if (
        firstMessage.type === "STATUS_UPDATE"
        && firstMessage.status === "waiting_for_login"
      ) {
        options.stateStore.updateProvider(providerId, {
          status: "waiting_for_login",
        });
        result = providerId === "marriott"
          ? await waitForMarriottLoginAndExtract(attemptId, tabId)
          : await waitForGenericLoginAndExtract(providerId, attemptId, tabId);
      } else if (firstMessage.type === "EXTRACTION_DONE") {
        result = firstMessage;
      } else if (firstMessage.type === "ERROR") {
        const recovery = await recoverFromStall({
          providerId,
          attemptId,
          tabId,
          isFirstPhase: true,
          assertRunActive: options.stateStore.assertRunActive,
          triggerExtraction: () =>
            triggerExtraction({
              providerId,
              attemptId,
              tabId,
              assertRunActive: options.stateStore.assertRunActive,
            }),
        });
        if (recovery === "login_needed") {
          options.stateStore.updateProvider(providerId, {
            status: "waiting_for_login",
          });
          result = providerId === "marriott"
            ? await waitForMarriottLoginAndExtract(attemptId, tabId)
            : await waitForGenericLoginAndExtract(providerId, attemptId, tabId);
        } else {
          const retryMessage = await new Promise<Record<string, unknown>>(
            (resolve) => {
              const timeout = setTimeout(() => {
                chrome.runtime.onMessage.removeListener(listener);
                resolve({
                  type: "ERROR",
                  provider: providerId,
                  error: "Retry timed out",
                });
              }, 60000);

              function listener(
                message: Record<string, unknown>,
                _sender: chrome.runtime.MessageSender,
                sendResponse: (response?: unknown) => void,
              ) {
                if (
                  (message.type === "EXTRACTION_DONE"
                    || message.type === "STATUS_UPDATE")
                  && options.isProviderAttemptMessage(message, providerId, attemptId)
                ) {
                  chrome.runtime.onMessage.removeListener(listener);
                  clearTimeout(timeout);
                  sendResponse({ ok: true });
                  resolve(message);
                  return true;
                }
              }

              chrome.runtime.onMessage.addListener(listener);
            },
          );
          result = retryMessage;
        }
      } else {
        throw new Error("Unexpected response from content script.");
      }

      if (result.type === "EXTRACTION_DONE" && result.data) {
        const data =
          result.data as MarriottLoyaltyData
          | AALoyaltyData
          | DeltaLoyaltyData
          | UnitedLoyaltyData
          | SouthwestLoyaltyData
          | AmexLoyaltyData
          | CapitalOneLoyaltyData
          | HiltonLoyaltyData
          | FrontierLoyaltyData;
        options.stateStore.assertRunActive(providerId, attemptId);
        options.stateStore.updateProvider(providerId, {
          status: "done",
          data,
          error: null,
          lastSyncedAt: new Date().toISOString(),
        });

        options.stateStore.assertRunActive(providerId, attemptId);
        void options.pushToNextCard(providerId, data).then((pushResult) => {
          if (pushResult.ok) {
          } else {
            console.warn(
              `[NextCard SW] ${definition.name} push failed:`,
              pushResult.error,
            );
          }
        });
        options.stateStore.finishSyncRun(providerId, attemptId);
      } else {
        options.stateStore.updateProvider(providerId, {
          status: "error",
          error: "No data extracted",
        });
      }
    } catch (error) {
      if (options.stateStore.wasRunCancelled(providerId, attemptId, error)) {
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : "Sync failed";
      options.stateStore.updateProvider(providerId, {
        status: "error",
        error: errorMessage,
      });
      console.error(`[NextCard SW] ${definition.name} sync error:`, error);
    }
  }

  return {
    startSync,
    startAtmosSync,
    waitForGenericLoginAndExtract,
  };
}
