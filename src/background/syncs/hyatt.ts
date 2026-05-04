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

interface HyattSyncDeps {
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  extensionNavigatingTabs: Set<number>;
  waitForGenericLoginAndExtract: (
    providerId: "hyatt",
    attemptId: string,
    tabId: number,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  isProviderAttemptMessage: (
    message: Record<string, unknown>,
    providerId: "hyatt",
    attemptId: string,
    type?: string,
  ) => boolean;
  pushToNextCard: (
    providerId: "hyatt",
    data: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
}

function isAwardsMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { type: "AWARDS_SCRAPED"; awards: unknown[] } {
  return value.type === "AWARDS_SCRAPED" && Array.isArray(value.awards);
}

export function createHyattSync(options: HyattSyncDeps) {
  function setHyattProgress(
    message: string,
    status: "extracting" | "detecting_login" | "waiting_for_login" = "extracting",
  ) {
    options.stateStore.updateProvider("hyatt", {
      status,
      progressMessage: message,
    });
  }

  return async function startHyattSync() {
    const attemptId = options.stateStore.beginSyncRun("hyatt").attemptId;
    const definition = options.providerRegistry.hyatt;
    const accountUrl = definition.accountUrl;
    if (!accountUrl) {
      throw new Error("Missing Hyatt account URL");
    }

    options.stateStore.updateProvider("hyatt", {
      status: "detecting_login",
      error: null,
      progressMessage: "Opening Hyatt...",
    });

    try {
      const tab = await chrome.tabs.create({ url: accountUrl, active: true });
      const tabId = tab.id;
      if (!tabId) {
        throw new Error("Could not create tab");
      }

      await waitForTabLoad(tabId, 30000);
      options.stateStore.recordRunTab("hyatt", attemptId, tabId, { owned: true });
      setHyattProgress("Checking Hyatt sign-in...", "detecting_login");

      const firstMessage = await new Promise<Record<string, unknown>>((resolve) => {
        const timeout = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve({
            type: "ERROR",
            provider: "hyatt",
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
            && options.isProviderAttemptMessage(message, "hyatt", attemptId)
          ) {
            chrome.runtime.onMessage.removeListener(listener);
            clearTimeout(timeout);
            sendResponse({ ok: true });
            resolve(message);
            return true;
          }
        }

        chrome.runtime.onMessage.addListener(listener);
        setHyattProgress("Reading Hyatt points and tier...");
        void triggerExtraction({
          providerId: "hyatt",
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
        }).catch(() => {
          chrome.runtime.onMessage.removeListener(listener);
          clearTimeout(timeout);
          resolve({
            type: "ERROR",
            provider: "hyatt",
            error: "Content script not available",
          });
        });
      });

      let overviewResult: Record<string, unknown>;
      if (
        firstMessage.type === "STATUS_UPDATE"
        && firstMessage.status === "waiting_for_login"
      ) {
        setHyattProgress("Waiting for Hyatt sign-in...", "waiting_for_login");
        overviewResult = await options.waitForGenericLoginAndExtract(
          "hyatt",
          attemptId,
          tabId,
        );
      } else if (firstMessage.type === "EXTRACTION_DONE") {
        overviewResult = firstMessage;
      } else {
        setHyattProgress("Waiting for Hyatt sign-in...", "waiting_for_login");
        overviewResult = await options.waitForGenericLoginAndExtract(
          "hyatt",
          attemptId,
          tabId,
        );
      }

      setHyattProgress("Reading Hyatt points and tier...");
      if (overviewResult.type !== "EXTRACTION_DONE" || !overviewResult.data) {
        options.stateStore.updateProvider("hyatt", {
          status: "error",
          error: "No data extracted from overview",
          progressMessage: null,
        });
        return;
      }

      const overviewData: Record<string, unknown> =
        typeof overviewResult.data === "object" && overviewResult.data !== null
          ? { ...overviewResult.data }
          : {};

      try {
        setHyattProgress("Opening Hyatt awards...");
        await navigateAndWait(
          tabId,
          "https://www.hyatt.com/profile/en-US/awards",
          options.extensionNavigatingTabs,
        );

        const awardsResult = await new Promise<Record<string, unknown>>((resolve) => {
          const timeout = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            resolve({ type: "TIMEOUT" });
          }, 12000);

          function listener(
            message: Record<string, unknown>,
            _sender: chrome.runtime.MessageSender,
            sendResponse: (response?: unknown) => void,
          ) {
            if (
              options.isProviderAttemptMessage(
                message,
                "hyatt",
                attemptId,
                "AWARDS_SCRAPED",
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
          setHyattProgress("Reading Hyatt awards...");
          void sendRunMessageToTab(
            tabId,
            "hyatt",
            attemptId,
            { type: "SCRAPE_AWARDS" },
            options.stateStore.assertRunActive,
          ).catch(() => {
            chrome.runtime.onMessage.removeListener(listener);
            clearTimeout(timeout);
            resolve({ type: "TIMEOUT" });
          });
        });

        if (isAwardsMessage(awardsResult)) {
          overviewData.awards = awardsResult.awards;
        }
      } catch (error) {
        console.warn(
          "[NextCard SW] Hyatt awards scrape failed, continuing with overview data:",
          error,
        );
      }

      options.stateStore.assertRunActive("hyatt", attemptId);
      setHyattProgress("Saving Hyatt rewards to nextcard...");
      options.stateStore.updateProvider("hyatt", {
        status: "done",
        data: overviewData,
        error: null,
        lastSyncedAt: new Date().toISOString(),
        progressMessage: null,
      });

      options.stateStore.assertRunActive("hyatt", attemptId);
      void options.pushToNextCard("hyatt", overviewData).then((pushResult) => {
        if (pushResult.ok) {
        } else {
          console.warn("[NextCard SW] Hyatt push failed:", pushResult.error);
        }
      });
      options.stateStore.finishSyncRun("hyatt", attemptId);
    } catch (error) {
      if (options.stateStore.wasRunCancelled("hyatt", attemptId, error)) {
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : "Sync failed";
      options.stateStore.updateProvider("hyatt", {
        status: "error",
        error: errorMessage,
        progressMessage: null,
      });
      console.error("[NextCard SW] Hyatt sync error:", error);
    }
  };
}
