import {
  OFFER_OPERATION_STORAGE_KEY,
  applyOfferOperationPatch,
  createOfferOperation,
  isOfferOperationActive,
  isOfferOperationHistoryFresh,
  isOfferResultFresh,
  normalizeOfferOperationSnapshot,
  type OfferIssuer,
  type OfferOperationCard,
  type OfferOperationSnapshot,
  type OfferOperationState,
} from "../lib/offer-operation";
import type { HouseholdOperationScope } from "../lib/household-context";

type OperationPatch = Partial<Omit<OfferOperationState, "runId" | "issuer" | "startedAt">>;
const UNATTACHED_OPENING_TTL_MS = 30_000;

export function createOfferOperationStore() {
  let snapshot: OfferOperationSnapshot = { active: null, history: {} };
  let hydrated = false;
  let hydrationPromise: Promise<OfferOperationSnapshot> | null = null;
  let startQueue = Promise.resolve();

  async function persist() {
    snapshot = normalizeOfferOperationSnapshot(snapshot);
    await chrome.storage.local.set({ [OFFER_OPERATION_STORAGE_KEY]: snapshot });
  }

  async function hydrate() {
    if (hydrated) return snapshot;
    hydrationPromise ??= chrome.storage.local.get(OFFER_OPERATION_STORAGE_KEY).then((stored) => {
      snapshot = normalizeOfferOperationSnapshot(stored[OFFER_OPERATION_STORAGE_KEY]);
      hydrated = true;
      return snapshot;
    });
    return hydrationPromise;
  }

  async function reconcile() {
    await hydrate();
    const retainedHistory: OfferOperationSnapshot["history"] = {};
    let historyChanged = false;
    for (const issuer of ["chase", "amex", "citi", "capitalone"] as const) {
      const state = snapshot.history[issuer];
      if (!state) continue;
      if (!isOfferOperationHistoryFresh(state)) {
        historyChanged = true;
        continue;
      }
      retainedHistory[issuer] = state;
    }
    if (historyChanged) {
      snapshot = { ...snapshot, history: retainedHistory };
      await persist();
    }

    const active = snapshot.active;
    if (!active || !isOfferOperationActive(active.phase)) return snapshot;
    if (active.phase === "ready_to_add" && !isOfferResultFresh(active)) {
      snapshot = { ...snapshot, active: null };
      await persist();
      return snapshot;
    }
    if (
      active.phase === "adding"
      && active.total != null
      && active.added + active.failed >= active.total
    ) {
      await patch(active.runId, {
        phase: active.cancelled ? "cancelled" : "completed",
        remaining: 0,
      });
      return snapshot;
    }

    if (active.ownedTabId == null) {
      const openingStartedAt = new Date(active.startedAt).getTime();
      const openingExpired = active.phase === "opening"
        && (
          !Number.isFinite(openingStartedAt)
          || Date.now() - openingStartedAt >= UNATTACHED_OPENING_TTL_MS
        );
      if (active.phase !== "opening" || openingExpired) {
        await patch(active.runId, {
          phase: "interrupted",
          error: "The issuer tab is no longer available.",
        });
      }
      return snapshot;
    }

    const tab = await chrome.tabs.get(active.ownedTabId).catch(() => null);
    if (!tab) {
      await patch(active.runId, {
        phase: "interrupted",
        ownedTabId: null,
        error: "The issuer tab was closed.",
      });
    }
    return snapshot;
  }

  async function start(
    issuer: OfferIssuer,
    scope: HouseholdOperationScope | null = null,
  ) {
    let resolveResult!: (value:
      | { ok: false; busy: OfferIssuer; state: OfferOperationState }
      | { ok: true; state: OfferOperationState }
    ) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<
      | { ok: false; busy: OfferIssuer; state: OfferOperationState }
      | { ok: true; state: OfferOperationState }
    >((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    startQueue = startQueue
      .catch(() => {})
      .then(async () => {
        try {
          await reconcile();
          const active = snapshot.active;
          if (active && isOfferOperationActive(active.phase)) {
            resolveResult({ ok: false, busy: active.issuer, state: active });
            return;
          }
          const state = createOfferOperation(
            issuer,
            crypto.randomUUID(),
            new Date().toISOString(),
            scope,
          );
          snapshot = {
            active: state,
            history: { ...snapshot.history, [issuer]: state },
          };
          await persist();
          resolveResult({ ok: true, state });
        } catch (error) {
          rejectResult(error);
        }
      });
    return result;
  }

  async function patch(runId: string, changes: OperationPatch) {
    await hydrate();
    const patchesActiveRun = snapshot.active?.runId === runId;
    const current =
      patchesActiveRun
        ? snapshot.active
        : Object.values(snapshot.history).find((state) => state?.runId === runId) ?? null;
    if (!current) return null;

    const next = applyOfferOperationPatch(current, changes);
    if (!next) return null;
    snapshot = {
      active: patchesActiveRun
        ? isOfferOperationActive(next.phase) ? next : null
        : snapshot.active,
      history: { ...snapshot.history, [next.issuer]: next },
    };
    await persist();
    return next;
  }

  async function markReady(
    runId: string,
    cards: OfferOperationCard[],
  ) {
    await hydrate();
    const current = snapshot.active?.runId === runId
      ? snapshot.active
      : null;
    const preserveRecentCompletion =
      current?.phase === "checking"
      && current.added > 0
      && current.saveStatus !== "not_started";
    return patch(runId, {
      phase: "ready_to_add",
      cards,
      checkedAt: new Date().toISOString(),
      error: null,
      total: null,
      added: preserveRecentCompletion ? current.added : 0,
      failed: preserveRecentCompletion ? current.failed : 0,
      remaining: null,
      saveStatus: preserveRecentCompletion ? "saved" : "not_started",
      saveError: null,
    });
  }

  async function patchActiveIssuer(issuer: OfferIssuer, changes: OperationPatch) {
    await hydrate();
    if (!snapshot.active || snapshot.active.issuer !== issuer) return null;
    return patch(snapshot.active.runId, changes);
  }

  async function patchActiveRun(
    issuer: OfferIssuer,
    runId: string,
    changes: OperationPatch,
  ) {
    await hydrate();
    if (
      !snapshot.active
      || snapshot.active.issuer !== issuer
      || snapshot.active.runId !== runId
    ) {
      return null;
    }
    return patch(runId, changes);
  }

  async function getActiveRun(issuer: OfferIssuer, runId: string) {
    await hydrate();
    return snapshot.active?.issuer === issuer && snapshot.active.runId === runId
      ? snapshot.active
      : null;
  }

  async function getRun(issuer: OfferIssuer, runId: string) {
    await hydrate();
    if (snapshot.active?.issuer === issuer && snapshot.active.runId === runId) {
      return snapshot.active;
    }
    const historical = snapshot.history[issuer];
    return historical?.runId === runId ? historical : null;
  }

  async function beginEnrollment(
    runId: string,
    selectedCardKeys: string[],
    total: number | null,
  ) {
    await reconcile();
    const active = snapshot.active;
    if (!active || active.runId !== runId) {
      return { ok: false as const, error: "run_not_active" };
    }
    if (!isOfferResultFresh(active)) {
      return { ok: false as const, error: "results_stale" };
    }
    const availableKeys = new Set(active.cards.map((card) => card.key));
    if (
      selectedCardKeys.length === 0
      || selectedCardKeys.some((key) => !availableKeys.has(key))
    ) {
      return { ok: false as const, error: "invalid_card_selection" };
    }
    const state = await patch(runId, {
      phase: "adding",
      selectedCardKeys,
      total,
      added: 0,
      failed: 0,
      remaining: total,
      cancelled: false,
      error: null,
      saveStatus: "not_started",
    });
    return state
      ? { ok: true as const, state }
      : { ok: false as const, error: "invalid_transition" };
  }

  async function continueAfterEnrollmentCompletion(runId: string) {
    await hydrate();
    const completed = Object.values(snapshot.history).find(
      (state) => state?.runId === runId,
    ) ?? null;
    if (
      !completed
      || completed.phase !== "completed"
      || completed.saveStatus === "not_started"
      || completed.saveStatus === "saving"
      || completed.cards.length === 0
      || completed.selectedCardKeys.length === 0
    ) {
      return null;
    }
    if (snapshot.active && snapshot.active.runId !== runId) return null;

    const selectedKeys = new Set(completed.selectedCardKeys);
    const refreshAllCounts =
      completed.issuer === "amex" || completed.selectedCardKeys.length > 1;
    const cards = completed.cards.map((card) => {
      if (refreshAllCounts) {
        return {
          ...card,
          availableCount: null,
          countStatus: "unknown" as const,
          sharedOfferCount: null,
        };
      }
      if (!selectedKeys.has(card.key) || card.availableCount == null) return card;
      return {
        ...card,
        availableCount: Math.max(0, card.availableCount - completed.added),
      };
    });
    const now = new Date().toISOString();
    const next: OfferOperationState = {
      ...createOfferOperation(
        completed.issuer,
        crypto.randomUUID(),
        now,
        completed.scope,
      ),
      phase: refreshAllCounts ? "checking" : "ready_to_add",
      ownedTabId: completed.ownedTabId,
      checkedAt: completed.checkedAt ?? now,
      cards,
      selectedCardKeys: completed.selectedCardKeys,
      added: completed.added,
      failed: completed.failed,
      saveStatus: completed.saveStatus,
      saveError: completed.saveError,
    };
    snapshot = {
      active: next,
      history: { ...snapshot.history, [completed.issuer]: next },
    };
    await persist();
    return next;
  }

  async function cancel(runId?: string, closeTab = true) {
    await hydrate();
    const active = snapshot.active;
    if (!active || (runId && active.runId !== runId)) return null;
    const state = await patch(active.runId, {
      phase: "cancelled",
      cancelled: true,
      remaining:
        active.total == null
          ? null
          : Math.max(0, active.total - active.added - active.failed),
    });
    if (closeTab && active.ownedTabId != null) {
      await chrome.tabs.remove(active.ownedTabId).catch(() => {});
    }
    return state;
  }

  async function clearAccountState() {
    await hydrate();
    const ownedTabId = snapshot.active?.ownedTabId ?? null;
    snapshot = { active: null, history: {} };
    hydrated = true;
    await chrome.storage.local.remove(OFFER_OPERATION_STORAGE_KEY);
    if (ownedTabId != null) {
      void chrome.tabs.remove(ownedTabId).catch(() => {});
    }
  }

  return {
    hydrate,
    reconcile,
    start,
    patch,
    patchActiveIssuer,
    patchActiveRun,
    getActiveRun,
    getRun,
    beginEnrollment,
    continueAfterEnrollmentCompletion,
    markReady,
    cancel,
    clearAccountState,
    async getSnapshot() {
      await reconcile();
      return snapshot;
    },
  };
}

export type OfferOperationStore = ReturnType<typeof createOfferOperationStore>;
