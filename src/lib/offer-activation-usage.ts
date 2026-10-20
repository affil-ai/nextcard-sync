import { z } from "zod";
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

const serverAllowanceSchema = z.object({
  month: z.string(),
  accountLevel: z.enum(["free", "pro"]),
  used: z.number().finite().nonnegative(),
  reserved: z.number().finite().nonnegative().optional(),
  limit: z.number().finite().nonnegative().nullable(),
  remaining: z.number().finite().nonnegative().nullable(),
});
const serverReservationSchema = serverAllowanceSchema.extend({
  granted: z.number().finite().nonnegative(),
});

export type OfferActivationUsage = z.infer<typeof serverAllowanceSchema>;

export interface OfferActivationReservation extends OfferActivationUsage {
  ok: boolean;
  requested: number;
  granted: number;
  error?: "monthly_offer_limit_reached" | "offer_run_unavailable" | "quota_unavailable";
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
    accountLevel: isPro ? "pro" : "free",
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
      const parsed = serverAllowanceSchema.safeParse(await response.json());
      if (response.ok && parsed.success) {
        const body = parsed.data;
        if (__MOCK_FREE_PLAN__) return getLocalOfferActivationUsage(email, false);
        return body;
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
      const parsed = serverReservationSchema.safeParse(await response.json());
      if ((response.ok || response.status === 409) && parsed.success) {
        const body = parsed.data;
        const local = __MOCK_FREE_PLAN__
          ? await getLocalOfferActivationUsage(email, false)
          : null;
        const serverGranted = Math.min(safeRequested, Math.floor(body.granted));
        const granted = local?.remaining != null
          ? Math.min(serverGranted, local.remaining)
          : serverGranted;
        const allowance = local ?? body;
        const ok = response.ok && granted > 0;
        if (ok) return { ...allowance, ok: true, requested: safeRequested, granted };
        const exhausted = allowance.accountLevel === "free"
          && allowance.limit !== null && allowance.remaining === 0;
        return {
          ...allowance,
          ok: false,
          requested: safeRequested,
          granted: 0,
          error: exhausted ? "monthly_offer_limit_reached" : "offer_run_unavailable",
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
