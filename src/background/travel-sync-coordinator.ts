import type { ProviderId, TravelSyncState } from "../lib/types";
import type { HouseholdOperationScope } from "../lib/household-context";

export const TRAVEL_SYNC_STORAGE_KEY = "nextcard_travel_sync_v1";
export const TRAVEL_SYNC_RESULT_FRESHNESS_MS = 60 * 60 * 1000;

interface TravelSyncStorage {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

interface TravelSyncCoordinatorOptions {
  storage: TravelSyncStorage;
  isProviderId: (value: unknown) => value is ProviderId;
  prepareProvider?: (
    providerId: ProviderId,
    scope: HouseholdOperationScope | null,
  ) => Promise<boolean | void>;
  startProvider: (providerId: ProviderId) => Promise<boolean>;
  waitForCompletion: (providerId: ProviderId) => Promise<{ succeeded: boolean }>;
  cancelProvider: (providerId: ProviderId) => Promise<void>;
  getCurrentScope?: () => Promise<HouseholdOperationScope | null>;
  now?: () => number;
}

interface PersistedTravelSyncState extends TravelSyncState {
  cancelRequested: boolean;
  scope: HouseholdOperationScope | null;
}

function idleState(): PersistedTravelSyncState {
  return {
    status: "idle",
    providerIds: [],
    currentProviderId: null,
    processedCount: 0,
    failedCount: 0,
    startedAt: null,
    updatedAt: null,
    cancelRequested: false,
    scope: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeScope(value: unknown): HouseholdOperationScope | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.accountScopeId !== "string"
    || typeof value.memberId !== "string"
    || typeof value.memberDisplayName !== "string"
    || typeof value.memberLifecycleVersion !== "number"
    || typeof value.contextRevision !== "string"
  ) {
    return null;
  }
  return {
    accountScopeId: value.accountScopeId,
    memberId: value.memberId,
    memberDisplayName: value.memberDisplayName,
    memberLifecycleVersion: value.memberLifecycleVersion,
    contextRevision: value.contextRevision,
  };
}

function scopesMatch(
  left: HouseholdOperationScope | null,
  right: HouseholdOperationScope | null,
) {
  if (!left || !right) return left === right;
  return left.accountScopeId === right.accountScopeId
    && left.memberId === right.memberId
    && left.memberLifecycleVersion === right.memberLifecycleVersion
    && left.contextRevision === right.contextRevision;
}

export function createTravelSyncCoordinator(
  options: TravelSyncCoordinatorOptions,
) {
  let state = idleState();
  let hydrated = false;
  let hydrationPromise: Promise<void> | null = null;
  let runPromise: Promise<void> | null = null;
  let runGeneration = 0;

  function publicState(): TravelSyncState {
    return {
      status: state.status,
      providerIds: state.providerIds,
      currentProviderId: state.currentProviderId,
      processedCount: state.processedCount,
      failedCount: state.failedCount,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    };
  }

  async function persist() {
    await options.storage.set({ [TRAVEL_SYNC_STORAGE_KEY]: state });
  }

  async function clearExpiredResult() {
    if (state.status !== "complete" && state.status !== "cancelled") return;
    const updatedAt = state.updatedAt ? Date.parse(state.updatedAt) : Number.NaN;
    const now = options.now?.() ?? Date.now();
    if (
      Number.isFinite(updatedAt)
      && now - updatedAt <= TRAVEL_SYNC_RESULT_FRESHNESS_MS
    ) {
      return;
    }
    state = idleState();
    await options.storage.remove(TRAVEL_SYNC_STORAGE_KEY);
  }

  async function hydrate() {
    if (hydrated) {
      await clearExpiredResult();
      return;
    }
    if (!hydrationPromise) {
      hydrationPromise = (async () => {
        const stored = await options.storage.get(TRAVEL_SYNC_STORAGE_KEY);
        const value = stored[TRAVEL_SYNC_STORAGE_KEY];
        if (isRecord(value)) {
          const providerIds = Array.isArray(value.providerIds)
            ? value.providerIds.filter(options.isProviderId)
            : [];
          const status = value.status === "running"
            || value.status === "complete"
            || value.status === "cancelled"
            ? value.status
            : "idle";
          const processedCount = typeof value.processedCount === "number"
            ? Math.max(0, Math.min(providerIds.length, Math.floor(value.processedCount)))
            : 0;
          const failedCount = typeof value.failedCount === "number"
            ? Math.max(0, Math.min(processedCount, Math.floor(value.failedCount)))
            : 0;
          state = {
            status,
            providerIds,
            currentProviderId:
              options.isProviderId(value.currentProviderId)
                ? value.currentProviderId
                : null,
            processedCount,
            failedCount,
            startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
            cancelRequested: value.cancelRequested === true,
            scope: normalizeScope(value.scope),
          };
          if (state.status === "running" && providerIds.length === 0) {
            state = idleState();
          }
        }
        hydrated = true;
      })().finally(() => {
        hydrationPromise = null;
      });
    }
    await hydrationPromise;
    await clearExpiredResult();
  }

  async function finishCancelled() {
    state = {
      ...state,
      status: "cancelled",
      currentProviderId: null,
      updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      cancelRequested: false,
    };
    await persist();
  }

  async function run(generation: number) {
    for (let index = state.processedCount; index < state.providerIds.length; index += 1) {
      if (state.cancelRequested) {
        await finishCancelled();
        return;
      }

      const providerId = state.providerIds[index];
      state = {
        ...state,
        currentProviderId: providerId,
        updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      };
      await persist();
      if (generation !== runGeneration) return;
      if (state.cancelRequested) {
        await finishCancelled();
        return;
      }

      let succeeded = false;
      try {
        const prepared = await options.prepareProvider?.(providerId, state.scope);
        if (generation !== runGeneration) return;
        if (prepared === false) {
          await finishCancelled();
          return;
        }
        const started = await options.startProvider(providerId);
        if (generation !== runGeneration) return;
        if (state.cancelRequested) {
          if (started) await options.cancelProvider(providerId);
          if (generation !== runGeneration) return;
          await finishCancelled();
          return;
        }
        if (started) {
          succeeded = (await options.waitForCompletion(providerId)).succeeded;
        }
      } catch {
        succeeded = false;
      }

      if (generation !== runGeneration) return;
      state = {
        ...state,
        processedCount: index + 1,
        failedCount: state.failedCount + (succeeded ? 0 : 1),
        updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      };
      await persist();
      if (generation !== runGeneration) return;

      if (state.cancelRequested) {
        await finishCancelled();
        return;
      }
    }

    state = {
      ...state,
      status: "complete",
      currentProviderId: null,
      updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    };
    await persist();
  }

  function ensureRunning() {
    if (state.status !== "running" || runPromise) return;
    const generation = runGeneration;
    runPromise = run(generation).finally(() => {
      if (generation === runGeneration) runPromise = null;
    });
  }

  async function ensureScopeStillCurrent() {
    if (state.status !== "running" || !options.getCurrentScope) return true;
    const generation = runGeneration;
    const currentScope = await options.getCurrentScope();
    if (generation !== runGeneration) return false;
    if (scopesMatch(state.scope, currentScope)) return true;
    if (runPromise) {
      await cancel();
    } else {
      await finishCancelled();
    }
    return false;
  }

  async function cancel() {
    await hydrate();
    if (state.status !== "running") return publicState();
    const generation = runGeneration;
    state = {
      ...state,
      cancelRequested: true,
      updatedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    };
    await persist();
    if (generation !== runGeneration) return publicState();
    if (state.currentProviderId) {
      await options.cancelProvider(state.currentProviderId);
    }
    if (generation !== runGeneration) return publicState();
    const activeRun = runPromise;
    if (activeRun) {
      await activeRun;
    } else {
      await finishCancelled();
    }
    return publicState();
  }

  return {
    async resume() {
      await hydrate();
      if (await ensureScopeStillCurrent()) ensureRunning();
      return publicState();
    },

    async getStatus() {
      await hydrate();
      if (await ensureScopeStillCurrent()) ensureRunning();
      return publicState();
    },

    async start(providerIds: ProviderId[]) {
      await hydrate();
      if (state.status === "running") return publicState();
      const uniqueProviderIds = [...new Set(providerIds)];
      if (uniqueProviderIds.length === 0) return publicState();
      const generation = runGeneration;
      const scope = await options.getCurrentScope?.() ?? null;
      if (generation !== runGeneration) return publicState();
      const now = new Date(options.now?.() ?? Date.now()).toISOString();
      state = {
        status: "running",
        providerIds: uniqueProviderIds,
        currentProviderId: uniqueProviderIds[0],
        processedCount: 0,
        failedCount: 0,
        startedAt: now,
        updatedAt: now,
        cancelRequested: false,
        scope,
      };
      await persist();
      ensureRunning();
      return publicState();
    },

    cancel,

    async clear() {
      await hydrate();
      const providerId = state.status === "running" ? state.currentProviderId : null;
      // Old asynchronous work must not update a new account or block clearing it.
      runGeneration += 1;
      runPromise = null;
      state = idleState();
      if (providerId) {
        void options.cancelProvider(providerId).catch(() => undefined);
      }
      await options.storage.remove(TRAVEL_SYNC_STORAGE_KEY);
      return publicState();
    },

    async resetResult() {
      await hydrate();
      if (state.status === "running") return publicState();
      state = idleState();
      await options.storage.remove(TRAVEL_SYNC_STORAGE_KEY);
      return publicState();
    },
  };
}
