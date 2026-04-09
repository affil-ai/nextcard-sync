import type { ProviderId } from "./types";

export interface SyncRun {
  attemptId: string;
  provider: ProviderId;
  ownedTabId: number | null;
  observedTabIds: Set<number>;
  cancelled: boolean;
}

export class SyncRunCancelledError extends Error {
  provider: ProviderId;
  attemptId: string;

  constructor(provider: ProviderId, attemptId: string) {
    super(`Sync run cancelled for ${provider}`);
    this.name = "SyncRunCancelledError";
    this.provider = provider;
    this.attemptId = attemptId;
  }
}

function createRun(provider: ProviderId, attemptId: string): SyncRun {
  return {
    attemptId,
    provider,
    ownedTabId: null,
    observedTabIds: new Set<number>(),
    cancelled: false,
  };
}

export function createSyncRunRegistry() {
  const runs = new Map<ProviderId, SyncRun>();

  function beginRun(provider: ProviderId, attemptId: string = crypto.randomUUID()) {
    const run = createRun(provider, attemptId);
    runs.set(provider, run);
    return run;
  }

  function getRun(provider: ProviderId) {
    return runs.get(provider) ?? null;
  }

  function isActive(provider: ProviderId, attemptId: string) {
    const run = runs.get(provider);
    return !!run && !run.cancelled && run.attemptId === attemptId;
  }

  function assertRunActive(provider: ProviderId, attemptId: string) {
    if (!isActive(provider, attemptId)) {
      throw new SyncRunCancelledError(provider, attemptId);
    }
  }

  function shouldAcceptMessage(provider: ProviderId, attemptId: string) {
    return isActive(provider, attemptId);
  }

  function recordObservedTab(
    provider: ProviderId,
    attemptId: string,
    tabId: number,
    options: { owned: boolean },
  ) {
    const run = runs.get(provider);
    if (!run || run.attemptId !== attemptId) return null;

    run.observedTabIds.add(tabId);
    if (options.owned) {
      // We only close tabs the extension created so cancel stays user-safe.
      run.ownedTabId = tabId;
    }

    return run;
  }

  function markCancelled(provider: ProviderId) {
    const run = runs.get(provider);
    if (!run) return null;
    run.cancelled = true;
    return run;
  }

  function clearRun(provider: ProviderId, attemptId?: string) {
    const run = runs.get(provider);
    if (!run) return;
    if (attemptId && run.attemptId !== attemptId) return;
    runs.delete(provider);
  }

  return {
    beginRun,
    getRun,
    isActive,
    assertRunActive,
    shouldAcceptMessage,
    recordObservedTab,
    markCancelled,
    clearRun,
  };
}
