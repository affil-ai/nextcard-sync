import type {
  ChaseBenefit,
  ChaseURData,
  ProviderId,
} from "../../lib/types";
import type { ProviderDefinition } from "../../providers/provider-registry";
import type { createRuntimeStateStore } from "../core/runtime-state";
import {
  waitForTabLoad,
  triggerExtraction,
  tabClosedSignal,
} from "../core/tab-utils";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

type ChaseCardSummary = {
  accountId: string;
  cardName: string;
  lastFour: string;
};

type ChaseRoute =
  | { kind: "benefits_hub"; url: string }
  | { kind: "ur_portal"; url: string }
  | { kind: "loyalty_portal"; url: string }
  | { kind: "session_expired"; url: string };

type ChasePoints = {
  available: number | null;
  pending: number | null;
};

interface ChaseSyncDeps {
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  extensionNavigatingTabs: Set<number>;
  isProviderAttemptMessage: (
    message: Record<string, unknown>,
    providerId: "chase",
    attemptId: string,
    type?: string,
  ) => boolean;
  pushToNextCard: (
    providerId: "chase",
    data: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
}

const CO_BRAND_KEYWORDS = [
  "marriott",
  "united",
  "southwest",
  "disney",
  "aarp",
  "amazon",
  "hyatt",
  "ihg",
  "british",
  "aer lingus",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function isChaseCardSummary(value: unknown): value is ChaseCardSummary {
  return (
    isRecord(value)
    && typeof value.accountId === "string"
    && typeof value.cardName === "string"
    && typeof value.lastFour === "string"
  );
}

function isChasePoints(value: unknown): value is ChasePoints {
  return (
    isRecord(value)
    && (typeof value.available === "number" || value.available === null)
    && (typeof value.pending === "number" || value.pending === null)
  );
}

function isChaseBenefit(value: unknown): value is ChaseBenefit {
  return (
    isRecord(value)
    && typeof value.name === "string"
    && (typeof value.amountUsed === "number" || value.amountUsed === null)
    && (typeof value.totalAmount === "number" || value.totalAmount === null)
    && (typeof value.remaining === "number" || value.remaining === null)
    && (typeof value.period === "string" || value.period === null)
  );
}

function readChaseBenefits(value: unknown) {
  return Array.isArray(value) ? value.filter(isChaseBenefit) : [];
}

function isChaseRoute(value: unknown): value is ChaseRoute {
  return (
    isRecord(value)
    && (
      value.kind === "benefits_hub"
      || value.kind === "ur_portal"
      || value.kind === "loyalty_portal"
      || value.kind === "session_expired"
    )
    && typeof value.url === "string"
  );
}

export function createChaseSync(options: ChaseSyncDeps) {
  let progressTabId: number | null = null;

  function setChaseProgress(message: string, status: "extracting" | "waiting_for_login" = "extracting") {
    options.stateStore.updateProvider("chase", {
      status,
      progressMessage: message,
    });

    if (progressTabId == null) return;
    void chrome.tabs.sendMessage(progressTabId, {
      type: "UPDATE_OVERLAY_PROGRESS",
      message,
    }).catch(() => {
      // Chase navigates across pages aggressively; overlay polling is the reliable path.
    });
  }

  function waitForChaseMessage(
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
          options.isProviderAttemptMessage(message, "chase", attemptId, messageType)
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

  async function chaseDashboardHasContent(tabId: number) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const accountButtons = document.querySelectorAll(
            '[data-testid^="accounts-name-link-button-"]',
          );
          if (accountButtons.length > 0) {
            return true;
          }

          const dataTables = document.querySelectorAll(
            'mds-data-table-for-accounts[data-testid^="account-table-"]',
          );
          if (dataTables.length > 0) {
            return true;
          }

          function walkShadow(root: Document | ShadowRoot): boolean {
            for (const element of root.querySelectorAll("*")) {
              const testId = element.getAttribute("data-testid") ?? "";
              if (testId.startsWith("accounts-name-link-button-")) {
                return true;
              }
              if (element.shadowRoot && walkShadow(element.shadowRoot)) {
                return true;
              }
            }
            return false;
          }

          if (walkShadow(document)) {
            return true;
          }

          const bodyText = document.body?.innerText ?? "";
          return (
            /\(\.\.\.\d{4}\)/.test(bodyText) || /\(…\d{4}\)/.test(bodyText)
          );
        },
      });
      return results[0]?.result === true;
    } catch {
      return false;
    }
  }

  function waitForChaseDashboardContent(
    attemptId: string,
    tabId: number,
    timeoutMs = 180000,
  ) {
    const closed = tabClosedSignal(tabId);
    const cancelled = options.stateStore.createRunCancelSignal("chase", attemptId);

    return Promise.race([
      closed.promise.then(() => {
        throw new Error("Tab was closed");
      }),
      cancelled.promise,
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Timed out waiting for Chase login"));
        }, timeoutMs);

        let pollInterval: ReturnType<typeof setInterval> | null = null;

        function startPolling() {
          pollInterval = setInterval(async () => {
            const hasContent = await chaseDashboardHasContent(tabId);
            if (hasContent) {
              cleanup();
              resolve();
            }
          }, 1000);
        }

        function onTabUpdated(
          updatedTabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          tab: chrome.tabs.Tab,
        ) {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") {
            return;
          }

          const url = tab.url ?? "";
          const isTwoFactor =
            url.includes("caas/challenge") || url.includes("confirmIdentity");

          if (isTwoFactor) {
            options.stateStore.updateProvider("chase", {
              status: "waiting_for_login",
              progressMessage: "Waiting for Chase sign-in...",
            });
          }
        }

        function cleanup() {
          clearTimeout(timeout);
          closed.cancel();
          cancelled.cancel();
          if (pollInterval) {
            clearInterval(pollInterval);
          }
          chrome.tabs.onUpdated.removeListener(onTabUpdated);
        }

        chrome.tabs.onUpdated.addListener(onTabUpdated);
        startPolling();
      }),
    ]);
  }

  function waitForChaseCondition<T>(
    attemptId: string,
    tabId: number,
    label: string,
    check: () => Promise<T | null>,
    timeoutMs = 15000,
    pollMs = 500,
  ): Promise<T> {
    const closed = tabClosedSignal(tabId);
    const cancelled = options.stateStore.createRunCancelSignal("chase", attemptId);

    return Promise.race([
      closed.promise,
      cancelled.promise,
      new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);

        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let checkInFlight = false;

        const runCheck = async () => {
          if (checkInFlight) {
            return;
          }
          checkInFlight = true;

          try {
            const result = await check();
            if (result != null) {
              cleanup();
              resolve(result);
              return;
            }
          } catch {
            // Chase re-renders aggressively during SPA navigation, so transient reads are expected.
          } finally {
            checkInFlight = false;
          }

          pollTimer = setTimeout(() => {
            void runCheck();
          }, pollMs);
        };

        function cleanup() {
          clearTimeout(timeout);
          closed.cancel();
          cancelled.cancel();
          if (pollTimer) {
            clearTimeout(pollTimer);
          }
        }

        void runCheck();
      }),
    ]);
  }

  async function getChaseCreditCardIds(tabId: number) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const cards: ChaseCardSummary[] = [];

        function parseLastFour(raw: string) {
          const match = raw.match(/\(\.{3}(\d{4})\)/);
          if (match) {
            return {
              cardName: raw.replace(/\s*\(\.{3}\d{4}\)/, "").trim(),
              lastFour: match[1],
            };
          }

          return { cardName: raw.trim(), lastFour: "" };
        }

        const tiles = document.querySelectorAll('[data-testid="customAccordion-tile"]');
        for (const tile of tiles) {
          const tileText = tile.textContent?.trim() ?? "";
          if (!tileText.toLowerCase().startsWith("credit card")) {
            continue;
          }

          const buttons = tile.querySelectorAll(
            '[data-testid^="accounts-name-link-button-"]',
          );
          for (const button of buttons) {
            const testId =
              button.getAttribute("id")
              ?? button.getAttribute("data-testid")
              ?? "";
            const accountId = testId.replace("accounts-name-link-button-", "");
            if (!accountId || !/^\d+$/.test(accountId)) {
              continue;
            }

            const parsed = parseLastFour(button.getAttribute("text") ?? "");
            cards.push({
              accountId,
              cardName: parsed.cardName,
              lastFour: parsed.lastFour,
            });
          }
        }

        if (cards.length > 0) {
          return cards;
        }

        const cardTables = document.querySelectorAll(
          'mds-data-table-for-accounts[data-testid^="account-table-CARD"]',
        );
        for (const table of cardTables) {
          const rowData = table.getAttribute("row-data");
          if (!rowData) {
            continue;
          }

          try {
            const rows = JSON.parse(rowData);
            if (!Array.isArray(rows)) {
              continue;
            }

            for (const row of rows) {
              if (!Array.isArray(row)) {
                continue;
              }

              const nameCell = row[0];
              const metaCell = row[row.length - 1];
              const name =
                typeof nameCell?.value === "string" ? nameCell.value : null;
              const accountId =
                typeof metaCell?.accountId === "number"
                  ? String(metaCell.accountId)
                  : null;
              if (!name || !accountId) {
                continue;
              }

              const parsed = parseLastFour(name);
              cards.push({
                accountId,
                cardName: parsed.cardName,
                lastFour: parsed.lastFour,
              });
            }
          } catch {
            // Skip malformed row-data payloads and keep trying other tables.
          }
        }

        return cards;
      },
    });

    const result = results[0]?.result;
    if (!Array.isArray(result)) {
      return [];
    }

    return result.filter(isChaseCardSummary);
  }

  function waitForChaseCreditCards(
    attemptId: string,
    tabId: number,
    timeoutMs = 15000,
  ) {
    return waitForChaseCondition(
      attemptId,
      tabId,
      "Chase credit cards",
      async () => {
        const cards = await getChaseCreditCardIds(tabId);
        return cards.length > 0 ? cards : null;
      },
      timeoutMs,
      500,
    );
  }

  function waitForChaseCardRoute(
    attemptId: string,
    tabId: number,
    accountId: string,
    timeoutMs = 15000,
  ) {
    const accountQuery = `account=${accountId}`;
    return waitForChaseCondition(
      attemptId,
      tabId,
      "Chase card route",
      async () => {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const url = tab?.url ?? "";
        if (!url) {
          return null;
        }

        if (url.includes("ultimaterewardspoints.chase.com")) {
          return { kind: "ur_portal", url };
        }
        if (url.includes("chaseloyalty.chase.com")) {
          return { kind: "loyalty_portal", url };
        }
        if (url.includes("logoff") || url.includes("logon")) {
          return { kind: "session_expired", url };
        }
        if (
          url.includes("secure.chase.com")
          && url.includes("benefits/hub")
          && url.includes(accountQuery)
        ) {
          return { kind: "benefits_hub", url };
        }

        return null;
      },
      timeoutMs,
      250,
    );
  }

  async function scrapePointsFromCurrentPage(tabId: number) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          let available: number | null = null;
          let pending: number | null = null;

          // UR portal pages expose balance as a data attribute on the nav header
          const balanceAttr = document.querySelector("[data-displayed-balance]")
            ?.getAttribute("data-displayed-balance");
          if (balanceAttr) {
            const parsed = parseInt(balanceAttr.replace(/,/g, ""), 10);
            if (!Number.isNaN(parsed)) available = parsed;
          }

          if (available == null) {
            for (const element of document.querySelectorAll(".points-balance .points")) {
              const numberElement = element.querySelector(".mds-title-large span");
              if (!numberElement) {
                continue;
              }
              const rawValue = (numberElement.textContent ?? "")
                .trim()
                .replace(/[,\s]/g, "");
              if (!/^-?\d+$/.test(rawValue)) {
                continue;
              }
              const parsedValue = parseInt(rawValue, 10);
              const context = (element.textContent ?? "").toLowerCase();
              if (context.includes("available") && available == null) {
                available = parsedValue;
              } else if (context.includes("pending") && pending == null) {
                pending = parsedValue;
              }
            }
          }

          if (available == null) {
            function walkForCardButton(root: Document | ShadowRoot): number | null {
              for (const element of root.querySelectorAll("*")) {
                if (element.tagName === "BUTTON") {
                  const text = (element.textContent ?? "").trim();
                  const match = text.match(/(-?[\d,]+)\s*pts?\s*$/i);
                  if (match) {
                    const parsedValue = parseInt(
                      match[1].replace(/,/g, ""),
                      10,
                    );
                    if (!Number.isNaN(parsedValue)) {
                      return parsedValue;
                    }
                  }
                }

                if (element.shadowRoot) {
                  const nestedValue = walkForCardButton(element.shadowRoot);
                  if (nestedValue != null) {
                    return nestedValue;
                  }
                }
              }

              return null;
            }

            const shadowValue = walkForCardButton(document);
            if (shadowValue != null) {
              available = shadowValue;
            }
          }

          return available != null ? { available, pending } : null;
        },
      });

      const result = results[0]?.result;
      return isChasePoints(result) ? result : null;
    } catch {
      return null;
    }
  }

  function waitForChasePointsOnCurrentPage(
    attemptId: string,
    tabId: number,
    timeoutMs = 15000,
  ) {
    return waitForChaseCondition(
      attemptId,
      tabId,
      "Chase points",
      async () => scrapePointsFromCurrentPage(tabId),
      timeoutMs,
      500,
    ).catch(() => null);
  }

  async function navigateChaseTabAndWaitForLoad(tabId: number, url: string) {
    // Chase has its own readiness checks, so this helper only waits for load completion.
    options.extensionNavigatingTabs.add(tabId);
    try {
      await chrome.tabs.update(tabId, { url });
      await waitForTabLoad(tabId, 30000);
    } finally {
      options.extensionNavigatingTabs.delete(tabId);
    }
  }

  async function scrapeChaseCard(
    attemptId: string,
    tabId: number,
    accountId: string,
    cardName: string,
  ) {
    const hubHash = `#/dashboard/benefits/hub?account=${accountId}`;
    let benefits: ChaseBenefit[] = [];
    let availablePoints: number | null = null;
    let pendingPoints: number | null = null;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (hash: string) => {
          window.location.hash = hash;
        },
        args: [hubHash],
      });

      let route = await waitForChaseCardRoute(attemptId, tabId, accountId);

      // Chase sometimes briefly lands on benefits/hub before redirecting to the UR portal.
      // Wait a moment and re-check to avoid starting a 120s extraction on a page that's about to leave.
      if (route.kind === "benefits_hub") {
        await new Promise((r) => setTimeout(r, 2000));
        const recheckTab = await chrome.tabs.get(tabId).catch(() => null);
        const recheckUrl = recheckTab?.url ?? "";
        if (recheckUrl.includes("ultimaterewardspoints.chase.com")) {
          route = { kind: "ur_portal", url: recheckUrl };
        } else if (recheckUrl.includes("chaseloyalty.chase.com")) {
          route = { kind: "loyalty_portal", url: recheckUrl };
        } else if (recheckUrl.includes("logoff") || recheckUrl.includes("logon")) {
          route = { kind: "session_expired", url: recheckUrl };
        }
      }

      if (route.kind === "benefits_hub") {
        const hasHub = route.url.includes("benefits/hub");
        if (hasHub) {
          try {
            setChaseProgress(`Reading benefits for ${cardName}...`);
            const benefitsMessage = waitForChaseMessage(
              attemptId,
              "CHASE_BENEFITS_DONE",
              120000,
            );
            await triggerExtraction({
              providerId: "chase",
              attemptId,
              tabId,
              assertRunActive: options.stateStore.assertRunActive,
            });
            const benefitsResult = await benefitsMessage.promise;
            benefits = readChaseBenefits(benefitsResult.benefits);
          } catch (error) {
            const postTab = await chrome.tabs.get(tabId);
            const postUrl = postTab.url ?? "";
            if (!postUrl.includes("secure.chase.com")) {
              setChaseProgress(`Reading points for ${cardName}...`);
              const points = await waitForChasePointsOnCurrentPage(attemptId, tabId);
              if (points) {
                availablePoints = points.available;
                pendingPoints = points.pending;
              }
            } else {
              console.warn("[NextCard SW] Chase: benefits extraction failed:", error);
            }
          }
        }

        const isCoBrandCard = CO_BRAND_KEYWORDS.some((keyword) =>
          cardName.toLowerCase().includes(keyword)
        );
        if (availablePoints == null && !isCoBrandCard) {
          try {
            const urUrl = `https://ultimaterewardspoints.chase.com/home?AI=${accountId}`;
            setChaseProgress(`Reading points for ${cardName}...`);
            await navigateChaseTabAndWaitForLoad(tabId, urUrl);
            const points = await waitForChasePointsOnCurrentPage(attemptId, tabId);
            if (points) {
              availablePoints = points.available;
              pendingPoints = points.pending;
            }
          } catch (error) {
          }
        }
      } else if (route.kind === "ur_portal") {
        setChaseProgress(`Reading points for ${cardName}...`);
        const points = await waitForChasePointsOnCurrentPage(attemptId, tabId);
        if (points) {
          availablePoints = points.available;
          pendingPoints = points.pending;
        }
      } else if (route.kind === "loyalty_portal") {
        setChaseProgress(`Reading rewards for ${cardName}...`);
        const points = await waitForChasePointsOnCurrentPage(attemptId, tabId);
        if (points) {
          availablePoints = points.available;
        }
      } else if (route.kind === "session_expired") {
      } else {
      }
    } catch (error) {
      console.warn(
        `[NextCard SW] Chase: card scrape failed for account ${accountId}:`,
        error,
      );
    }

    return { benefits, availablePoints, pendingPoints };
  }

  async function chaseFinalize(attemptId: string, allCards: ChaseURData[]) {
    const primaryCard = allCards[0];
    const fullData: ChaseURData = {
      cardName: primaryCard.cardName,
      lastFourDigits: primaryCard.lastFourDigits,
      availablePoints: primaryCard.availablePoints,
      pendingPoints: primaryCard.pendingPoints,
      benefits: primaryCard.benefits,
    };

    // Preserve multi-card payloads so the downstream transform still sees every Chase card.
    const multiCardData = allCards.length > 1
      ? { ...fullData, _allCards: allCards }
      : fullData;

    setChaseProgress("Saving Chase rewards to nextcard...");
    options.stateStore.assertRunActive("chase", attemptId);
    options.stateStore.updateProvider("chase", {
      status: "done",
      data: multiCardData,
      error: null,
      lastSyncedAt: new Date().toISOString(),
      progressMessage: null,
    });

    options.stateStore.assertRunActive("chase", attemptId);
    void options.pushToNextCard("chase", multiCardData).then((pushResult) => {
      if (pushResult.ok) {
      } else {
        console.warn("[NextCard SW] Chase push failed:", pushResult.error);
      }
    });
    options.stateStore.finishSyncRun("chase", attemptId);
  }

  return async function startChaseSync() {
    const attemptId = options.stateStore.beginSyncRun("chase").attemptId;
    const definition = options.providerRegistry.chase;
    options.stateStore.updateProvider("chase", {
      status: "detecting_login",
      error: null,
      progressMessage: "Opening Chase...",
    });

    try {
      const tab = await chrome.tabs.create({ url: definition.syncUrl, active: true });
      const tabId = tab.id;
      if (!tabId) {
        throw new Error("Could not create tab");
      }

      progressTabId = tabId;
      await waitForTabLoad(tabId, 30000);
      options.stateStore.recordRunTab("chase", attemptId, tabId, { owned: true });

      const alreadyLoaded = await chaseDashboardHasContent(tabId);
      if (!alreadyLoaded) {
        options.stateStore.updateProvider("chase", {
          status: "waiting_for_login",
          progressMessage: "Waiting for Chase sign-in...",
        });
        await waitForChaseDashboardContent(attemptId, tabId);
      }

      setChaseProgress("Finding your Chase cards...");

      const cardIds = await waitForChaseCreditCards(attemptId, tabId);

      if (cardIds.length === 0) {
        throw new Error("No credit cards found on Chase dashboard");
      }

      const isCoBrand = (name: string) =>
        CO_BRAND_KEYWORDS.some((keyword) => name.toLowerCase().includes(keyword));
      cardIds.sort((left, right) => Number(isCoBrand(left.cardName)) - Number(isCoBrand(right.cardName)));

      const allCards: ChaseURData[] = [];
      for (let index = 0; index < cardIds.length; index += 1) {
        const card = cardIds[index];

        setChaseProgress(`Syncing ${index + 1} of ${cardIds.length}: ${card.cardName}`);

        const currentTab = await chrome.tabs.get(tabId);
        const currentUrl = currentTab.url ?? "";
        if (!currentUrl.includes("secure.chase.com/web/auth/dashboard")) {
          if (currentUrl.includes("logoff") || currentUrl.includes("logon")) {
            break;
          }
          setChaseProgress("Returning to Chase dashboard...");
          await navigateChaseTabAndWaitForLoad(
            tabId,
            "https://secure.chase.com/web/auth/dashboard#/dashboard/overview",
          );
          await waitForChaseCreditCards(attemptId, tabId, 20000);

          const postNavigationTab = await chrome.tabs.get(tabId);
          const postNavigationUrl = postNavigationTab.url ?? "";
          if (
            postNavigationUrl.includes("logoff")
            || postNavigationUrl.includes("logon")
            || !postNavigationUrl.includes("secure.chase.com")
          ) {
            break;
          }
        }

        const result = await scrapeChaseCard(
          attemptId,
          tabId,
          card.accountId,
          card.cardName,
        );

        allCards.push({
          cardName: card.cardName,
          lastFourDigits: card.lastFour || null,
          availablePoints: result.availablePoints,
          pendingPoints: result.pendingPoints,
          benefits: result.benefits,
        });
      }

      try {
        setChaseProgress("Returning to Chase dashboard...");
        await navigateChaseTabAndWaitForLoad(
          tabId,
          "https://secure.chase.com/web/auth/dashboard#/dashboard/overview",
        );
      } catch {
        // Users sometimes end on a dead Chase session; we still keep the data we already captured.
      }

      if (allCards.length === 0) {
        throw new Error("No cards could be scraped");
      }

      await chaseFinalize(attemptId, allCards);
    } catch (error) {
      if (options.stateStore.wasRunCancelled("chase", attemptId, error)) {
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : "Sync failed";
      options.stateStore.updateProvider("chase", {
        status: "error",
        error: errorMessage,
        progressMessage: null,
      });
      console.error("[NextCard SW] Chase sync error:", error);
    } finally {
      progressTabId = null;
    }
  };
}
