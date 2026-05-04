import type { CapitalOneLoyaltyData, ProviderId } from "../../lib/types";
import type { ProviderDefinition } from "../../providers/provider-registry";
import type { createRuntimeStateStore } from "../core/runtime-state";
import {
  navigateAndWait,
  triggerExtraction,
  waitForTabLoad,
} from "../core/tab-utils";

type RuntimeStateStore = ReturnType<typeof createRuntimeStateStore>;

interface TravelCreditData {
  remaining: number;
  total: number;
  period: string | null;
}

interface CapitalOneSummaryCard {
  name: string;
  lastDigits: string;
}

interface CapitalOneSyncDeps {
  providerRegistry: Record<ProviderId, ProviderDefinition>;
  stateStore: RuntimeStateStore;
  extensionNavigatingTabs: Set<number>;
  waitForGenericLoginAndExtract: (
    providerId: "capitalone",
    attemptId: string,
    tabId: number,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>;
  isProviderAttemptMessage: (
    message: Record<string, unknown>,
    providerId: "capitalone",
    attemptId: string,
    type?: string,
  ) => boolean;
  pushToNextCard: (
    providerId: "capitalone",
    data: unknown,
  ) => Promise<{ ok: boolean; error?: string }>;
}

type CapitalOneBenefit = CapitalOneLoyaltyData["benefits"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readSummaryCards(value: unknown): CapitalOneSummaryCard[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }

    const name = readString(entry.name);
    const lastDigits = readString(entry.lastDigits);
    if (!name || !lastDigits) {
      return [];
    }

    return [{ name, lastDigits }];
  });
}

export function createCapitalOneSync(options: CapitalOneSyncDeps) {
  function setCapitalOneProgress(
    message: string,
    status: "extracting" | "detecting_login" | "waiting_for_login" = "extracting",
  ) {
    options.stateStore.updateProvider("capitalone", {
      status,
      progressMessage: message,
    });
  }

  function waitForCapitalOneMessage(
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
          options.isProviderAttemptMessage(
            message,
            "capitalone",
            attemptId,
            messageType,
          )
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

  async function scrapeCapitalOneTravelCredits(tabId: number) {
    // The annual credit balance lives in Capital One Travel, so we read it there.
    setCapitalOneProgress("Opening Capital One Travel credits...");
    await navigateAndWait(
      tabId,
      "https://travel.capitalone.com/travel-offers/#offers",
      options.extensionNavigatingTabs,
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));

    setCapitalOneProgress("Finding Capital One travel credit activity...");
    const clickResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const elements = document.querySelectorAll("a, button");
        for (const element of elements) {
          if (element.textContent?.trim().includes("View activity")) {
            if (element instanceof HTMLElement) {
              element.click();
              return true;
            }
          }
        }
        return false;
      },
    });

    if (clickResults[0]?.result !== true) {
      console.warn("[NextCard SW] CapitalOne: 'View activity' button not found");
      return null;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));

    setCapitalOneProgress("Reading Capital One travel credit balance...");
    const scrapeResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function parseDollarAmount(value: string) {
          const match = value.match(/\$([\d,]+(?:\.\d{1,2})?)/);
          if (!match) return null;

          const amount = Number.parseFloat(match[1].replace(/,/g, ""));
          return Number.isFinite(amount) ? amount : null;
        }

        function parseLastDollarAmount(value: string) {
          const matches = Array.from(value.matchAll(/\$([\d,]+(?:\.\d{1,2})?)/g));
          const lastMatch = matches.at(-1);
          if (!lastMatch) return null;

          const amount = Number.parseFloat(lastMatch[1].replace(/,/g, ""));
          return Number.isFinite(amount) ? amount : null;
        }

        function getVisibleLines(element: Element) {
          const text = element instanceof HTMLElement
            ? element.innerText
            : element.textContent ?? "";
          return text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        }

        function findDollarNearLabel(lines: string[], label: RegExp) {
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const labelMatch = line.match(label);
            if (!labelMatch) continue;

            const labelIndex = labelMatch.index ?? 0;
            const afterLabel = line.slice(labelIndex + labelMatch[0].length);
            const beforeLabel = line.slice(0, labelIndex);
            const inlineAmount =
              parseDollarAmount(afterLabel) ?? parseLastDollarAmount(beforeLabel);
            if (inlineAmount != null) return inlineAmount;

            const candidates = [
              lines[index + 1] ?? "",
              lines[index - 1] ?? "",
            ];
            for (const candidate of candidates) {
              const amount = parseDollarAmount(candidate);
              if (amount != null) return amount;
            }
          }

          return null;
        }

        const modal = document.querySelector(
          ".travel-credit-history-modal-root, .travel-credit-history-modal-content",
        );
        if (!modal) {
          return null;
        }

        const topSection = modal.querySelector(
          ".travel-credit-history-modal-top-section",
        );
        if (!topSection) {
          return null;
        }

        const topLines = getVisibleLines(topSection);
        const text = topLines.join("\n");
        const remaining = findDollarNearLabel(
          topLines,
          /available\s+to\s+spend\s+on\s+travel|available/i,
        ) ?? 0;

        const bottomSection = modal.querySelector(
          ".travel-credit-history-modal-bottom-section",
        );
        const bottomLines = bottomSection ? getVisibleLines(bottomSection) : [];
        const bottomText = bottomLines.join("\n");
        const total = findDollarNearLabel(topLines, /^annual\s+travel\s+credit$/i)
          ?? parseDollarAmount(
            bottomText.match(/ANNUAL TRAVEL CREDIT[^+]*\+\s*\$[\d,]+(?:\.\d{2})?/i)?.[0] ?? "",
          )
          ?? 300;

        const renewMatch = text.match(/Renews\s+(.+?)(?:\s*$|\s*Travel)/);
        const period = renewMatch ? `Renews ${renewMatch[1].trim()}` : null;

        return { remaining, total, period };
      },
    });

    const scraped = scrapeResults[0]?.result;
    if (!isRecord(scraped)) {
      return null;
    }

    const remaining = readNumber(scraped.remaining);
    const total = readNumber(scraped.total);
    if (remaining == null || total == null) {
      return null;
    }

    return {
      remaining,
      total,
      period: readString(scraped.period),
    } satisfies TravelCreditData;
  }

  async function capitalOneFinalize(
    attemptId: string,
    result: Record<string, unknown>,
    travelCredit: TravelCreditData | null = null,
  ) {
    const data = isRecord(result.data) ? result.data : {};
    const cards = readSummaryCards(result.cards);
    const totalRewards =
      readNumber(result.totalRewards) ?? readNumber(data.availablePoints);
    const rewardsLabel =
      readString(result.rewardsLabel) ?? readString(data.rewardsLabel) ?? "Rewards";

    const travelCreditBenefit: CapitalOneBenefit | null = travelCredit
      ? {
          name: "Annual Travel Credit",
          amountUsed:
            Math.round((travelCredit.total - travelCredit.remaining) * 100) / 100,
          totalAmount: travelCredit.total,
          remaining: travelCredit.remaining,
          period: travelCredit.period,
        }
      : null;

    const benefits = travelCreditBenefit ? [travelCreditBenefit] : [];

    const allCards = cards.length > 0
      ? cards.map((card, index) => {
          const isTopCard =
            card.name.toLowerCase().includes("venture x")
            || (index === 0 && cards.length === 1);
          return {
            cardName: `${card.name} (${card.lastDigits})`,
            availablePoints: index === 0 ? totalRewards : null,
            pendingPoints: null,
            rewardsLabel,
            benefits: isTopCard ? benefits : [],
          };
        })
      : [{
          cardName: readString(data.cardName),
          availablePoints: totalRewards,
          pendingPoints: null,
          rewardsLabel,
          benefits,
        }];

    const primaryCard = allCards[0];
    const fullData: CapitalOneLoyaltyData = {
      cardName: primaryCard.cardName,
      availablePoints: totalRewards,
      pendingPoints: null,
      rewardsLabel,
      benefits: primaryCard.benefits,
    };

    const multiCardData = allCards.length > 1
      ? { ...fullData, _allCards: allCards }
      : fullData;

    options.stateStore.assertRunActive("capitalone", attemptId);
    setCapitalOneProgress("Saving Capital One rewards to nextcard...");
    options.stateStore.updateProvider("capitalone", {
      status: "done",
      data: multiCardData,
      error: null,
      lastSyncedAt: new Date().toISOString(),
      progressMessage: null,
    });

    options.stateStore.assertRunActive("capitalone", attemptId);
    void options.pushToNextCard("capitalone", multiCardData).then((pushResult) => {
      if (pushResult.ok) {
      } else {
        console.warn("[NextCard SW] CapitalOne push failed:", pushResult.error);
      }
    });
    options.stateStore.finishSyncRun("capitalone", attemptId);
  }

  return async function startCapitalOneSync() {
    const attemptId = options.stateStore.beginSyncRun("capitalone").attemptId;
    const definition = options.providerRegistry.capitalone;
    options.stateStore.updateProvider("capitalone", {
      status: "detecting_login",
      error: null,
      progressMessage: "Opening Capital One...",
    });

    try {
      const tab = await chrome.tabs.create({ url: definition.syncUrl, active: true });
      const tabId = tab.id;
      if (!tabId) {
        throw new Error("Could not create tab");
      }

      await waitForTabLoad(tabId, 30000);
      options.stateStore.recordRunTab("capitalone", attemptId, tabId, {
        owned: true,
      });

      const currentTab = await chrome.tabs.get(tabId);
      const landingUrl = currentTab.url ?? "";

      const isLoggedIn =
        landingUrl.includes("myaccounts.capitalone.com/accountSummary")
        || landingUrl.includes("myaccounts.capitalone.com/Card/")
        || landingUrl.includes("myaccounts.capitalone.com/rewards");
      const isLogin =
        landingUrl.includes("verified.capitalone.com")
        || landingUrl.includes("identity-management");

      let summaryResult: Record<string, unknown>;
      if (isLoggedIn) {
        setCapitalOneProgress("Reading Capital One rewards...");

        if (!landingUrl.includes("accountSummary")) {
          setCapitalOneProgress("Opening Capital One account summary...");
          await navigateAndWait(
            tabId,
            definition.syncUrl,
            options.extensionNavigatingTabs,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
        const extractionMessage = waitForCapitalOneMessage(
          attemptId,
          "EXTRACTION_DONE",
        );
        setCapitalOneProgress("Reading Capital One rewards...");
        await triggerExtraction({
          providerId: "capitalone",
          attemptId,
          tabId,
          assertRunActive: options.stateStore.assertRunActive,
        });
        summaryResult = await extractionMessage.promise;
      } else if (isLogin) {
        setCapitalOneProgress("Waiting for Capital One sign-in...", "waiting_for_login");
        summaryResult = await options.waitForGenericLoginAndExtract(
          "capitalone",
          attemptId,
          tabId,
        );
      } else {
        setCapitalOneProgress("Waiting for Capital One sign-in...", "waiting_for_login");
        summaryResult = await options.waitForGenericLoginAndExtract(
          "capitalone",
          attemptId,
          tabId,
        );
      }

      let travelCredit: TravelCreditData | null = null;
      try {
        travelCredit = await scrapeCapitalOneTravelCredits(tabId);
      } catch (error) {
        console.warn(
          "[NextCard SW] CapitalOne: failed to scrape travel credits:",
          error,
        );
      }

      await capitalOneFinalize(attemptId, summaryResult, travelCredit);
    } catch (error) {
      if (options.stateStore.wasRunCancelled("capitalone", attemptId, error)) {
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : "Sync failed";
      options.stateStore.updateProvider("capitalone", {
        status: "error",
        error: errorMessage,
        progressMessage: null,
      });
      console.error("[NextCard SW] CapitalOne sync error:", error);
    }
  };
}
