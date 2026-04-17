import type { ProviderId } from "../../lib/types";
import type { ProviderDefinition } from "../../providers/provider-registry";
import type { createRuntimeStateStore } from "../core/runtime-state";
import {
  navigateAndWait,
  sendRunMessageToTab,
  triggerExtraction,
  waitForTabLoad,
} from "../core/tab-utils";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

interface BiltSyncDeps {
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  extensionNavigatingTabs: Set<number>;
  waitForGenericLoginAndExtract: (
    providerId: "bilt",
    attemptId: string,
    tabId: number,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  isProviderAttemptMessage: (
    message: Record<string, unknown>,
    providerId: "bilt",
    attemptId: string,
    type?: string,
  ) => boolean;
  pushToNextCard: (
    providerId: "bilt",
    data: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
}

function isProgressMessage(value: Record<string, unknown>) {
  return (
    value.type === "BILT_PROGRESS_DONE"
    && typeof value.progress === "object"
    && value.progress !== null
  );
}

export function createBiltSync(options: BiltSyncDeps) {
  return async function startBiltSync() {
    const attemptId = options.stateStore.beginSyncRun("bilt").attemptId;
    const definition = options.providerRegistry.bilt;
    const accountUrl = definition.accountUrl;
    if (!accountUrl) {
      throw new Error("Missing Bilt account URL");
    }

    options.stateStore.updateProvider("bilt", {
      status: "detecting_login",
      error: null,
    });

    try {
      const tab = await chrome.tabs.create({ url: accountUrl, active: true });
      const tabId = tab.id;
      if (!tabId) {
        throw new Error("Could not create tab");
      }

      await waitForTabLoad(tabId, 30000);
      options.stateStore.recordRunTab("bilt", attemptId, tabId, { owned: true });
      options.stateStore.updateProvider("bilt", { status: "extracting" });

      const firstMessage = await new Promise<Record<string, unknown>>((resolve) => {
        const timeout = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({
            type: "ERROR",
            provider: "bilt",
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
            && options.isProviderAttemptMessage(message, "bilt", attemptId)
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
          providerId: "bilt",
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
        }).catch(() => {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timeout);
          resolve({
            type: "ERROR",
            provider: "bilt",
            error: "Content script not available",
          });
        });
      });

      let accountResult: Record<string, unknown>;
      if (
        firstMessage.type === "STATUS_UPDATE"
        && firstMessage.status === "waiting_for_login"
      ) {
        options.stateStore.updateProvider("bilt", { status: "waiting_for_login" });
        accountResult = await options.waitForGenericLoginAndExtract(
          "bilt",
          attemptId,
          tabId,
        );
      } else if (firstMessage.type === "EXTRACTION_DONE") {
        accountResult = firstMessage;
      } else {
        options.stateStore.updateProvider("bilt", { status: "waiting_for_login" });
        accountResult = await options.waitForGenericLoginAndExtract(
          "bilt",
          attemptId,
          tabId,
        );
      }

      if (accountResult.type !== "EXTRACTION_DONE" || !accountResult.data) {
        options.stateStore.updateProvider("bilt", {
          status: "error",
          error: "No data extracted from account",
        });
        return;
      }

      const accountData =
        typeof accountResult.data === "object" && accountResult.data !== null
          ? { ...accountResult.data }
          : {};

      try {
        await navigateAndWait(
          tabId,
          "https://www.bilt.com/account/status-tracker",
          options.extensionNavigatingTabs,
        );

        const progressResult = await new Promise<Record<string, unknown>>((resolve) => {
          const timeout = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            resolve({ type: "TIMEOUT" });
          }, 15000);

          function listener(
            message: Record<string, unknown>,
            _sender: chrome.runtime.MessageSender,
            sendResponse: (response?: unknown) => void,
          ) {
            if (
              options.isProviderAttemptMessage(
                message,
                "bilt",
                attemptId,
                "BILT_PROGRESS_DONE",
              )
            ) {
              chrome.runtime.onMessage.removeListener(listener);
              clearTimeout(timeout);
              sendResponse({ ok: true });
              resolve(message);
              return true;
            }
          }

          chrome.runtime.onMessage.addListener(listener);
          void sendRunMessageToTab(
            tabId,
            "bilt",
            attemptId,
            { type: "SCRAPE_PROGRESS" },
            options.stateStore.assertRunActive,
          ).catch(() => {
            chrome.runtime.onMessage.removeListener(listener);
            clearTimeout(timeout);
            resolve({ type: "TIMEOUT" });
          });
        });

        if (isProgressMessage(progressResult)) {
          Object.assign(accountData, progressResult.progress);
        }
      } catch (error) {
        console.warn(
          "[NextCard SW] Bilt status tracker scrape failed, continuing with account data:",
          error,
        );
      }

      options.stateStore.assertRunActive("bilt", attemptId);
      options.stateStore.updateProvider("bilt", {
        status: "done",
        data: accountData,
        error: null,
        lastSyncedAt: new Date().toISOString(),
      });

      options.stateStore.assertRunActive("bilt", attemptId);
      void options.pushToNextCard("bilt", accountData).then((pushResult) => {
        if (pushResult.ok) {
        } else {
          console.warn("[NextCard SW] Bilt push failed:", pushResult.error);
        }
      });
      options.stateStore.finishSyncRun("bilt", attemptId);
    } catch (error) {
      if (options.stateStore.wasRunCancelled("bilt", attemptId, error)) {
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : "Sync failed";
      options.stateStore.updateProvider("bilt", {
        status: "error",
        error: errorMessage,
      });
      console.error("[NextCard SW] Bilt sync error:", error);
    }
  };
}
