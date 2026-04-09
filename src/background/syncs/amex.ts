import type { AmexLoyaltyData } from "../../lib/types";
import type { ProviderDefinition } from "../../providers/provider-registry";
import type { createRuntimeStateStore } from "../core/runtime-state";
import { sendRunMessageToTab, triggerExtraction, waitForTabLoad } from "../core/tab-utils";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

type AmexCardData = {
  cardName: string | null;
  availablePoints: number | null;
  pendingPoints: number | null;
  benefits: {
    name: string;
    amountUsed: number | null;
    totalAmount: number | null;
    remaining: number | null;
    period: string | null;
  }[];
};

interface AmexSyncDeps {
  providerRegistry: Record<"amex", ProviderDefinition> & Record<string, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  waitForGenericLoginAndExtract: (
    providerId: "amex",
    attemptId: string,
    tabId: number,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  isProviderAttemptMessage: (
    message: Record<string, unknown>,
    providerId: "amex",
    attemptId: string,
    type?: string,
  ) => boolean;
  pushToNextCard: (
    providerId: "amex",
    data: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function createAmexSync(options: AmexSyncDeps) {
  function waitForAmexMessage(
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
        if (options.isProviderAttemptMessage(message, "amex", attemptId, messageType)) {
          cleanup();
          sendResponse({ ok: true });
          resolve(message);
          return true;
        }
        if (
          options.isProviderAttemptMessage(message, "amex", attemptId, "STATUS_UPDATE")
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

  return async function startAmexSync() {
    const attemptId = options.stateStore.beginSyncRun("amex").attemptId;
    const definition = options.providerRegistry.amex;
    options.stateStore.updateProvider("amex", {
      status: "detecting_login",
      error: null,
    });

    try {
      const tab = await chrome.tabs.create({ url: definition.syncUrl, active: true });
      await waitForTabLoad(tab.id!, 30000);

      const tabId = tab.id;
      if (!tabId) throw new Error("Could not create tab");
      options.stateStore.recordRunTab("amex", attemptId, tabId, { owned: true });

      await new Promise((resolve) => setTimeout(resolve, 4000));
      const currentTab = await chrome.tabs.get(tabId);
      const landingUrl = currentTab.url ?? "";
      const isOnRewards = landingUrl.includes("global.americanexpress.com/rewards");
      const isOnDashboard = landingUrl.includes("global.americanexpress.com/dashboard");
      const isLoggedIn = isOnRewards || isOnDashboard;

      console.log(
        `[NextCard SW] Amex: landing URL after stabilization: ${landingUrl}, loggedIn=${isLoggedIn}`,
      );

      let firstResult: Record<string, unknown>;

      if (isLoggedIn) {
        options.stateStore.updateProvider("amex", { status: "extracting" });

        let redirectedToLogin = false;
        const onTabNav = (
          updatedTabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          navTab: chrome.tabs.Tab,
        ) => {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
          const url = navTab.url ?? "";
          if (
            url.includes("login")
            || url.includes("signin")
            || url.includes("sign-in")
          ) {
            redirectedToLogin = true;
          }
        };
        chrome.tabs.onUpdated.addListener(onTabNav);

        const extractionMessage = waitForAmexMessage(attemptId, "EXTRACTION_DONE");
        await triggerExtraction({
          providerId: "amex",
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
        });

        let stopPolling = false;
        const redirectCheck = new Promise<null>((resolve) => {
          const check = () => {
            if (stopPolling) return;
            if (redirectedToLogin) {
              resolve(null);
              return;
            }
            setTimeout(check, 1000);
          };
          setTimeout(check, 2000);
        });

        const raceResult = await Promise.race([
          extractionMessage.promise.then((result) => {
            stopPolling = true;
            return result;
          }),
          redirectCheck,
        ]);
        chrome.tabs.onUpdated.removeListener(onTabNav);
        stopPolling = true;

        if (raceResult === null) {
          console.log(
            "[NextCard SW] Amex: redirected to login during extraction, switching to login flow",
          );
          options.stateStore.updateProvider("amex", { status: "waiting_for_login" });
          firstResult = await options.waitForGenericLoginAndExtract(
            "amex",
            attemptId,
            tabId,
          );
        } else {
          firstResult = raceResult;
        }
      } else {
        options.stateStore.updateProvider("amex", { status: "waiting_for_login" });
        console.log("[NextCard SW] Amex: waiting for login...");
        firstResult = await options.waitForGenericLoginAndExtract(
          "amex",
          attemptId,
          tabId,
        );
      }

      if (
        firstResult.type === "STATUS_UPDATE"
        && firstResult.status === "waiting_for_login"
      ) {
        options.stateStore.updateProvider("amex", { status: "waiting_for_login" });
        firstResult = await options.waitForGenericLoginAndExtract(
          "amex",
          attemptId,
          tabId,
        );
      }

      if (firstResult.type !== "EXTRACTION_DONE" || !firstResult.data) {
        options.stateStore.updateProvider("amex", {
          status: "error",
          error: "No data extracted",
        });
        return;
      }

      const firstCard = firstResult.data as AmexCardData;
      const totalCards = (firstResult.totalCards as number) ?? 1;
      const allCards: AmexCardData[] = [firstCard];

      console.log(
        `[NextCard SW] Amex: first card scraped. Total cards available: ${totalCards}`,
      );

      if (totalCards > 1) {
        const cardOptions =
          (firstResult.cardOptions as {
            name: string;
            lastDigits: string;
            index: number;
          }[]) ?? [];

        for (let index = 0; index < cardOptions.length; index += 1) {
          const option = cardOptions[index];
          const firstLastDigits = firstCard.cardName?.match(/\d{4,5}/)?.[0];
          if (firstLastDigits && option.lastDigits === firstLastDigits) {
            console.log(
              `[NextCard SW] Amex: skipping already-scraped card: ${option.name} (${option.lastDigits})`,
            );
            continue;
          }

          console.log(
            `[NextCard SW] Amex: switching to card ${index + 1}/${cardOptions.length}: ${option.name}`,
          );

          const cardDone = waitForAmexMessage(attemptId, "AMEX_CARD_DONE", 30000);
          try {
            await sendRunMessageToTab(
              tabId,
              "amex",
              attemptId,
              { type: "START_EXTRACTION", cardIndex: option.index },
              options.stateStore.assertRunActive,
            );
          } catch {
            cardDone.cancel();
            console.warn(
              `[NextCard SW] Amex: failed to send extraction for card ${option.name}`,
            );
            continue;
          }

          try {
            const cardResult = await cardDone.promise;
            if (cardResult.data) {
              allCards.push(cardResult.data as AmexCardData);
              console.log(`[NextCard SW] Amex: scraped card: ${option.name}`);
            } else {
              console.warn(
                `[NextCard SW] Amex: no data for card: ${option.name}`,
                cardResult.error,
              );
            }
          } catch {
            console.warn(
              `[NextCard SW] Amex: timed out scraping card: ${option.name}`,
            );
          }
        }
      }

      const primaryCard = allCards[0];
      const fullData: AmexLoyaltyData = {
        cardName: primaryCard.cardName,
        availablePoints: primaryCard.availablePoints,
        pendingPoints: primaryCard.pendingPoints,
        benefits: primaryCard.benefits,
      };

      const multiCardData = {
        ...fullData,
        _allCards: allCards,
      };

      options.stateStore.assertRunActive("amex", attemptId);
      options.stateStore.updateProvider("amex", {
        status: "done",
        data: multiCardData,
        error: null,
        lastSyncedAt: new Date().toISOString(),
      });
      console.log(`[NextCard SW] Amex sync complete: ${allCards.length} cards scraped`);

      void sendRunMessageToTab(
        tabId,
        "amex",
        attemptId,
        { type: "AMEX_ALL_DONE" },
        options.stateStore.assertRunActive,
      ).catch(() => {});

      options.stateStore.assertRunActive("amex", attemptId);
      void options.pushToNextCard("amex", multiCardData).then((result) => {
        if (result.ok) {
          console.log("[NextCard SW] Amex pushed to NextCard");
        } else {
          console.warn("[NextCard SW] Amex push failed:", result.error);
        }
      });
      options.stateStore.finishSyncRun("amex", attemptId);
    } catch (error) {
      if (options.stateStore.wasRunCancelled("amex", attemptId, error)) {
        console.log("[NextCard SW] Amex sync cancelled");
        return;
      }
      const errorMessage =
        error instanceof Error ? error.message : "Sync failed";
      options.stateStore.updateProvider("amex", {
        status: "error",
        error: errorMessage,
      });
      console.error("[NextCard SW] Amex sync error:", error);
    }
  };
}
