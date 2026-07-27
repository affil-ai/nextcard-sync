import type { OfferIssuer, OfferOperationCard } from "../lib/offer-operation";
import type { OfferOperationStore } from "./offer-operation-store";

const ISSUER_CONFIG: Record<OfferIssuer, {
  url: string;
  origins: string[];
  discoverMessage: string;
  runMessage: string | null;
  stopMessage: string | null;
}> = {
  chase: {
    url: "https://secure.chase.com/web/auth/dashboard",
    origins: [
      "https://secure.chase.com",
      "https://secure01a.chase.com",
      "https://secure03a.chase.com",
      "https://secure05a.chase.com",
      "https://secure07a.chase.com",
    ],
    discoverMessage: "CHASE_OFFERS_DISCOVER",
    runMessage: "CHASE_OFFERS_RUN",
    stopMessage: "CHASE_OFFERS_STOP",
  },
  amex: {
    url: "https://global.americanexpress.com/offers",
    origins: ["https://global.americanexpress.com", "https://www.americanexpress.com"],
    discoverMessage: "AMEX_OFFERS_DISCOVER",
    runMessage: "AMEX_OFFERS_RUN",
    stopMessage: "AMEX_OFFERS_STOP",
  },
  citi: {
    url: "https://online.citi.com/US/ag/products-offers/merchantoffers",
    origins: ["https://online.citi.com"],
    discoverMessage: "CITI_OFFERS_DISCOVER",
    runMessage: "CITI_OFFERS_RUN",
    stopMessage: "CITI_OFFERS_STOP",
  },
  capitalone: {
    url: "https://myaccounts.capitalone.com/accountSummary",
    origins: ["https://myaccounts.capitalone.com", "https://capitaloneoffers.com"],
    discoverMessage: "CAPITALONE_OFFERS_DISCOVER",
    runMessage: null,
    stopMessage: "CAPITALONE_OFFERS_STOP",
  },
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeText(value: unknown, fallback: string, maxLength = 80) {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.slice(0, maxLength) || fallback;
}

function safeLastFour(value: unknown) {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function tabMatchesIssuer(url: string | undefined, issuer: OfferIssuer) {
  if (!url) return false;
  try {
    return ISSUER_CONFIG[issuer].origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function sendTabMessage(tabId: number, message: Record<string, unknown>) {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response && typeof response === "object"
        ? response as Record<string, unknown>
        : null);
    });
  });
}

function waitForTabComplete(tabId: number, timeoutMs = 45_000) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch(finish);
    setTimeout(finish, timeoutMs);
  });
}

function normalizeDiscoveryCards(
  issuer: OfferIssuer,
  response: Record<string, unknown>,
) {
  const counts = response.offerCounts && typeof response.offerCounts === "object"
    ? response.offerCounts as Record<string, unknown>
    : {};
  const sharedCounts = new Map<string, number>();
  if (issuer === "amex" && Array.isArray(response.sharedOfferPreview)) {
    for (const value of response.sharedOfferPreview) {
      if (!value || typeof value !== "object") continue;
      const preview = value as Record<string, unknown>;
      if (
        typeof preview.cardId === "string"
        && typeof preview.sharedOfferCount === "number"
        && Number.isFinite(preview.sharedOfferCount)
        && preview.sharedOfferCount >= 0
      ) {
        sharedCounts.set(preview.cardId, Math.floor(preview.sharedOfferCount));
      }
    }
  }
  if (!Array.isArray(response.cards)) return [];
  return response.cards.flatMap((value, index): OfferOperationCard[] => {
    if (!value || typeof value !== "object") return [];
    const card = value as Record<string, unknown>;
    const rawKey =
      typeof card.id === "string"
        ? card.id
        : typeof card.accountId === "string"
          ? card.accountId
          : "";
    if (!rawKey) return [];
    const count = counts[rawKey];
    return [{
      key: rawKey.slice(0, 160),
      name: safeText(card.name, `${issuer} card ${index + 1}`),
      lastDigits: safeLastFour(card.lastDigits),
      availableCount:
        typeof count === "number" && Number.isFinite(count) && count >= 0
          ? Math.floor(count)
          : null,
      countStatus: typeof count === "number" ? "complete" : "unknown",
      sharedOfferCount: sharedCounts.get(rawKey) ?? null,
    }];
  });
}

export function createOfferOperationCoordinator(store: OfferOperationStore) {
  const runningDiscoveries = new Set<string>();

  async function discover(issuer: OfferIssuer, runId: string, tabId: number) {
    if (runningDiscoveries.has(runId)) return;
    runningDiscoveries.add(runId);
    try {
    const config = ISSUER_CONFIG[issuer];
    await waitForTabComplete(tabId);
    await delay(1_500);

    for (let attempt = 0; attempt < 15; attempt += 1) {
      const snapshot = await store.getSnapshot();
      if (snapshot.active?.runId !== runId) return;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !tabMatchesIssuer(tab.url, issuer)) {
        await store.patch(runId, {
          phase: "interrupted",
          error: "The issuer tab is no longer available.",
          ownedTabId: null,
        });
        return;
      }

      await store.patch(runId, {
        phase: attempt === 0 ? "checking" : "waiting_for_login",
        error: null,
      });
      const response = await sendTabMessage(tabId, {
        type: config.discoverMessage,
        runId,
      });
      if (response?.redirectUrl && typeof response.redirectUrl === "string") {
        await chrome.tabs.update(tabId, { url: response.redirectUrl });
        await waitForTabComplete(tabId);
        await delay(1_500);
        continue;
      }
      const cards = response ? normalizeDiscoveryCards(issuer, response) : [];
      if (cards.length > 0) {
        await store.patch(runId, { phase: "checking", error: null });
        if (issuer === "capitalone") {
          await store.patch(runId, {
            phase: "completed",
            cards,
            total: cards.reduce((sum, card) => sum + (card.availableCount ?? 0), 0),
            saveStatus: "saved",
            error: null,
          });
        } else {
          await store.markReady(runId, cards);
        }
        return;
      }
      await delay(3_000);
    }

    await store.patch(runId, {
      phase: "failed",
      error: `Couldn’t check ${issuer === "amex" ? "Amex" : issuer[0].toUpperCase() + issuer.slice(1)}. Finish signing in, then try again.`,
    });
    } finally {
      runningDiscoveries.delete(runId);
    }
  }

  async function resume() {
    const snapshot = await store.getSnapshot();
    const active = snapshot.active;
    if (
      active
      && active.ownedTabId != null
      && (active.phase === "opening"
        || active.phase === "waiting_for_login"
        || active.phase === "checking")
    ) {
      void discover(active.issuer, active.runId, active.ownedTabId);
    }
  }

  async function startCheck(issuer: OfferIssuer) {
    const result = await store.start(issuer);
    if (!result.ok) return result;
    try {
      const tab = await chrome.tabs.create({
        url: ISSUER_CONFIG[issuer].url,
        active: true,
      });
      if (tab.id == null) throw new Error("Issuer tab did not open");
      await store.patch(result.state.runId, {
        phase: "waiting_for_login",
        ownedTabId: tab.id,
      });
      void discover(issuer, result.state.runId, tab.id);
      return {
        ok: true as const,
        state: (await store.getSnapshot()).active ?? result.state,
      };
    } catch {
      await store.patch(result.state.runId, {
        phase: "failed",
        error: "Couldn’t open the issuer. Try again.",
      });
      return { ok: false as const, error: "open_failed" };
    }
  }

  async function startEnrollment(
    runId: string,
    selectedCardKeys: string[],
    total: number | null,
    options: {
      addMatchingOffersAcrossCards?: boolean;
      maxOffers?: number | null;
    } = {},
  ) {
    const snapshot = await store.getSnapshot();
    const active = snapshot.active;
    if (!active || active.runId !== runId || active.ownedTabId == null) {
      return { ok: false as const, error: "run_not_active" };
    }
    const tab = await chrome.tabs.get(active.ownedTabId).catch(() => null);
    if (!tab || !tabMatchesIssuer(tab.url, active.issuer)) {
      return { ok: false as const, error: "issuer_session_unavailable" };
    }
    const selectedKey = selectedCardKeys[0];
    const selectedCard = active.cards.find((card) => card.key === selectedKey);
    if (!selectedCard) return { ok: false as const, error: "invalid_card_selection" };
    let sharedPreflightId: string | null = null;
    const addMatchingOffersAcrossCards =
      active.issuer === "amex" && options.addMatchingOffersAcrossCards === true;
    if (addMatchingOffersAcrossCards) {
      const preflight = await sendTabMessage(active.ownedTabId, {
        type: "AMEX_OFFERS_SHARED_PREFLIGHT",
        cardId: selectedKey,
        locale: "en-US",
        cards: active.cards.map((card) => ({
          id: card.key,
          name: card.name,
          lastDigits: card.lastDigits,
        })),
      });
      if (
        preflight?.ok !== true
        || typeof preflight.preflightId !== "string"
        || typeof preflight.matchingOfferCount !== "number"
        || preflight.matchingOfferCount <= 0
      ) {
        return { ok: false as const, error: "no_matching_offers" };
      }
      sharedPreflightId = preflight.preflightId;
    }
    const transitioned = await store.beginEnrollment(runId, selectedCardKeys, total);
    if (!transitioned.ok) return transitioned;

    const config = ISSUER_CONFIG[active.issuer];
    if (!config.runMessage) return { ok: false as const, error: "enrollment_not_supported" };
    const response = await sendTabMessage(active.ownedTabId, {
      type: config.runMessage,
      runId,
      cardId: selectedKey,
      accountId: selectedKey,
      allCardIds: active.cards.map((card) => card.key),
      locale: "en-US",
      cardName: selectedCard.name,
      cardLastDigits: selectedCard.lastDigits,
      addMatchingOffersAcrossCards,
      sharedPreflightId,
      maxOffers:
        typeof options.maxOffers === "number"
          ? Math.max(0, Math.floor(options.maxOffers))
          : null,
      cards: active.cards.map((card) => ({
        id: card.key,
        name: card.name,
        lastDigits: card.lastDigits,
        locale: "en-US",
      })),
    });
    if (response?.ok !== true) {
      await store.patch(runId, {
        phase: "failed",
        error: safeText(response?.error, "Couldn’t start adding offers. Check again."),
      });
      return { ok: false as const, error: "content_script_rejected" };
    }
    return transitioned;
  }

  async function refreshCheck(runId: string) {
    const snapshot = await store.getSnapshot();
    const active = snapshot.active;
    if (
      !active
      || active.runId !== runId
      || active.phase !== "ready_to_add"
      || active.ownedTabId == null
    ) {
      return { ok: false as const, error: "run_not_refreshable" };
    }
    const tab = await chrome.tabs.get(active.ownedTabId).catch(() => null);
    if (!tab || !tabMatchesIssuer(tab.url, active.issuer)) {
      return { ok: false as const, error: "issuer_session_unavailable" };
    }
    await store.patch(runId, {
      phase: "checking",
      error: null,
    });
    void discover(active.issuer, runId, active.ownedTabId);
    return {
      ok: true as const,
      state: (await store.getSnapshot()).active,
    };
  }

  async function cancel(runId?: string) {
    const snapshot = await store.getSnapshot();
    const active = snapshot.active;
    if (!active || (runId && active.runId !== runId)) return null;
    if (active.phase === "adding" && active.ownedTabId != null) {
      const stopMessage = ISSUER_CONFIG[active.issuer].stopMessage;
      if (stopMessage) {
        await store.patch(active.runId, { cancelled: true });
        await sendTabMessage(active.ownedTabId, {
          type: stopMessage,
          runId: active.runId,
        });
        return (await store.getSnapshot()).active;
      }
    }
    return store.cancel(active.runId, true);
  }

  async function clearAccountState() {
    const snapshot = await store.getSnapshot();
    const active = snapshot.active;
    if (active?.phase === "adding" && active.ownedTabId != null) {
      const stopMessage = ISSUER_CONFIG[active.issuer].stopMessage;
      if (stopMessage) {
        await sendTabMessage(active.ownedTabId, {
          type: stopMessage,
          runId: active.runId,
        });
      }
    }
    await store.clearAccountState();
  }

  return {
    startCheck,
    refreshCheck,
    startEnrollment,
    cancel,
    clearAccountState,
    resume,
  };
}

export type OfferOperationCoordinator = ReturnType<typeof createOfferOperationCoordinator>;
