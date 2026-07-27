import { getAuth } from "./auth";

export const FREE_MONTHLY_OFFER_ACTIVATION_LIMIT = 100;

const STORAGE_KEY = "offerActivationUsageByAccount";
const PENDING_COMPLETIONS_STORAGE_KEY = "pendingOfferActivationCompletions";
const MAX_PENDING_COMPLETIONS = 250;

interface StoredOfferActivationUsage {
  month: string;
  used: number;
  countedRunIds: string[];
}

type StoredUsageByAccount = Record<string, StoredOfferActivationUsage>;

export interface OfferActivationUsage {
  month: string;
  used: number;
  reserved?: number;
  limit: number | null;
  remaining: number | null;
}

export interface OfferActivationReservation extends OfferActivationUsage {
  ok: boolean;
  requested: number;
  granted: number;
  error?: "monthly_offer_limit_reached" | "quota_unavailable";
}

interface PendingOfferActivationCompletion {
  account: string;
  runId: string;
  added: number;
  queuedAt: string;
}

let completionRetryPromise: Promise<void> | null = null;
let completionQueueWritePromise: Promise<void> = Promise.resolve();

function currentMonth(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function accountKey(email: string | null | undefined) {
  return email?.trim().toLowerCase() || "signed-in-account";
}

function normalizeUsage(
  value: unknown,
  month = currentMonth(),
): StoredOfferActivationUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { month, used: 0, countedRunIds: [] };
  }
  const record = value as Record<string, unknown>;
  if (record.month !== month) {
    return { month, used: 0, countedRunIds: [] };
  }
  return {
    month,
    used:
      typeof record.used === "number" && Number.isFinite(record.used)
        ? Math.max(0, Math.floor(record.used))
        : 0,
    countedRunIds: Array.isArray(record.countedRunIds)
      ? record.countedRunIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

async function readUsageByAccount() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as StoredUsageByAccount
    : {};
}

async function getLocalOfferActivationUsage(
  email: string | null | undefined,
  isPro: boolean,
): Promise<OfferActivationUsage> {
  const month = currentMonth();
  const allUsage = await readUsageByAccount();
  const usage = normalizeUsage(allUsage[accountKey(email)], month);
  const limit = isPro ? null : FREE_MONTHLY_OFFER_ACTIVATION_LIMIT;
  return {
    month,
    used: usage.used,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - usage.used),
  };
}

async function readPendingCompletions(): Promise<PendingOfferActivationCompletion[]> {
  const stored = await chrome.storage.local.get(PENDING_COMPLETIONS_STORAGE_KEY);
  const value = stored[PENDING_COMPLETIONS_STORAGE_KEY];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !entry
      || typeof entry !== "object"
      || typeof entry.account !== "string"
      || typeof entry.runId !== "string"
      || typeof entry.added !== "number"
      || !Number.isFinite(entry.added)
    ) {
      return [];
    }
    return [{
      account: entry.account,
      runId: entry.runId,
      added: Math.max(0, Math.floor(entry.added)),
      queuedAt:
        typeof entry.queuedAt === "string"
          ? entry.queuedAt
          : new Date().toISOString(),
    }];
  });
}

async function writePendingCompletions(
  completions: PendingOfferActivationCompletion[],
) {
  if (completions.length === 0) {
    await chrome.storage.local.remove(PENDING_COMPLETIONS_STORAGE_KEY);
    return;
  }
  await chrome.storage.local.set({
    [PENDING_COMPLETIONS_STORAGE_KEY]: completions.slice(-MAX_PENDING_COMPLETIONS),
  });
}

function updatePendingCompletions(
  update: (
    pending: PendingOfferActivationCompletion[],
  ) => PendingOfferActivationCompletion[],
) {
  const operation = completionQueueWritePromise
    .catch(() => {})
    .then(async () => {
      const pending = await readPendingCompletions();
      await writePendingCompletions(update(pending));
    });
  completionQueueWritePromise = operation;
  return operation;
}

async function queueOfferActivationCompletion(
  email: string | null | undefined,
  runId: string,
  added: number,
) {
  const account = accountKey(email);
  const completion = {
    account,
    runId,
    added,
    queuedAt: new Date().toISOString(),
  };
  await updatePendingCompletions((pending) => {
    const existingIndex = pending.findIndex(
      (entry) => entry.account === account && entry.runId === runId,
    );
    if (existingIndex >= 0) {
      pending[existingIndex] = completion;
    } else {
      pending.push(completion);
    }
    return pending;
  });
}

export function retryPendingOfferActivationCompletions(): Promise<void> {
  if (completionRetryPromise) return completionRetryPromise;
  completionRetryPromise = (async () => {
    const auth = await getAuth();
    if (!auth?.token) return;
    const account = accountKey(auth.email);
    const pending = await readPendingCompletions();
    const completedKeys = new Set<string>();

    for (const completion of pending) {
      if (completion.account !== account) continue;
      try {
        const response = await fetch(
          `${__CONVEX_SITE_URL__}/extension/offer-activation-complete`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${auth.token}`,
            },
            body: JSON.stringify({
              runId: completion.runId,
              added: completion.added,
            }),
          },
        );
        if (response.ok) {
          completedKeys.add(`${completion.account}:${completion.runId}`);
        }
      } catch {}
    }

    if (completedKeys.size > 0) {
      await updatePendingCompletions((latest) => latest.filter(
        (completion) => !completedKeys.has(
          `${completion.account}:${completion.runId}`,
        ),
      ));
    }
  })().finally(() => {
    completionRetryPromise = null;
  });
  return completionRetryPromise;
}

export async function getOfferActivationUsage(
  email: string | null | undefined,
  isPro: boolean,
): Promise<OfferActivationUsage> {
  const auth = await getAuth();
  if (auth?.token) {
    try {
      const response = await fetch(
        `${__CONVEX_SITE_URL__}/extension/offer-activation-usage`,
        { headers: { Authorization: `Bearer ${auth.token}` } },
      );
      const body = await response.json() as Partial<OfferActivationUsage>;
      if (
        response.ok
        && typeof body.month === "string"
        && typeof body.used === "number"
        && (typeof body.limit === "number" || body.limit === null)
        && (typeof body.remaining === "number" || body.remaining === null)
      ) {
        const local = await getLocalOfferActivationUsage(email, isPro);
        const used = Math.max(local.used, Math.max(0, Math.floor(body.used)));
        const reserved =
          typeof body.reserved === "number"
            ? Math.max(0, Math.floor(body.reserved))
            : 0;
        const limit = __MOCK_FREE_PLAN__
          ? FREE_MONTHLY_OFFER_ACTIVATION_LIMIT
          : body.limit;
        return {
          month: body.month,
          used,
          reserved,
          limit,
          remaining:
            limit === null ? null : Math.max(0, limit - used - reserved),
        };
      }
    } catch {
      // Keep the extension usable while the compatible backend rolls out.
    }
  }

  return getLocalOfferActivationUsage(email, isPro);
}

export async function reserveOfferActivations(
  email: string | null | undefined,
  isPro: boolean,
  runId: string,
  requested: number,
): Promise<OfferActivationReservation> {
  const safeRequested = Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : 0;
  const auth = await getAuth();
  if (auth?.token && runId) {
    try {
      const response = await fetch(
        `${__CONVEX_SITE_URL__}/extension/offer-activation-reserve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({ runId, requested: safeRequested }),
        },
      );
      const body = await response.json() as Partial<OfferActivationReservation>;
      if (
        (response.ok || response.status === 409)
        && typeof body.month === "string"
        && typeof body.used === "number"
        && typeof body.granted === "number"
        && (typeof body.limit === "number" || body.limit === null)
        && (typeof body.remaining === "number" || body.remaining === null)
      ) {
        const local = await getLocalOfferActivationUsage(email, isPro);
        const serverGranted = Math.max(0, Math.floor(body.granted));
        const granted =
          local.remaining === null
            ? serverGranted
            : Math.min(serverGranted, local.remaining);
        const limit = __MOCK_FREE_PLAN__
          ? FREE_MONTHLY_OFFER_ACTIVATION_LIMIT
          : body.limit;
        return {
          ok: response.ok && granted > 0,
          month: body.month,
          used: Math.max(local.used, Math.max(0, Math.floor(body.used))),
          reserved:
            typeof body.reserved === "number"
              ? Math.max(0, Math.floor(body.reserved))
              : 0,
          limit,
          remaining:
            limit === null
              ? null
              : Math.max(
                  0,
                  Math.min(
                    typeof body.remaining === "number" ? body.remaining : 0,
                    local.remaining ?? Number.POSITIVE_INFINITY,
                  ),
                ),
          requested: safeRequested,
          granted,
          ...(!response.ok
            ? { error: "monthly_offer_limit_reached" as const }
            : {}),
        };
      }
    } catch {}
  }

  // Enrollment changes issuer state and cannot be undone. Once the compatible
  // backend is live, never proceed unless it has reserved this exact run.
  const usage = await getLocalOfferActivationUsage(email, isPro);
  return {
    ...usage,
    ok: false,
    requested: safeRequested,
    granted: 0,
    error: "quota_unavailable",
  };
}

export async function recordOfferActivations(
  email: string | null | undefined,
  runId: string,
  added: number,
) {
  const safeAdded = Number.isFinite(added) ? Math.max(0, Math.floor(added)) : 0;
  if (!runId) return;

  await queueOfferActivationCompletion(email, runId, safeAdded);
  await retryPendingOfferActivationCompletions();
  if (safeAdded === 0) return;

  const month = currentMonth();
  const key = accountKey(email);
  const allUsage = await readUsageByAccount();
  const usage = normalizeUsage(allUsage[key], month);
  if (usage.countedRunIds.includes(runId)) return;

  allUsage[key] = {
    month,
    used: usage.used + safeAdded,
    countedRunIds: [...usage.countedRunIds, runId].slice(-250),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: allUsage });
}

export function capOfferEnrollmentTotal(
  requested: number | null,
  remaining: number | null,
) {
  if (requested == null) return remaining;
  if (remaining == null) return Math.max(0, requested);
  return Math.max(0, Math.min(requested, remaining));
}
