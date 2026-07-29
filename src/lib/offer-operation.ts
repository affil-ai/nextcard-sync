export type OfferIssuer = "chase" | "amex" | "citi" | "capitalone";

export type OfferOperationPhase =
  | "opening"
  | "waiting_for_login"
  | "checking"
  | "ready_to_add"
  | "adding"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "failed";

export type OfferCountStatus = "unknown" | "partial" | "complete";

export type OfferSaveStatus =
  | "not_started"
  | "saving"
  | "saved"
  | "queued_for_retry"
  | "failed";

export interface OfferOperationCard {
  key: string;
  name: string;
  lastDigits: string | null;
  availableCount: number | null;
  countStatus: OfferCountStatus;
  sharedOfferCount?: number | null;
}

export interface OfferOperationState {
  runId: string;
  issuer: OfferIssuer;
  phase: OfferOperationPhase;
  ownedTabId: number | null;
  startedAt: string;
  updatedAt: string;
  checkedAt: string | null;
  cards: OfferOperationCard[];
  selectedCardKeys: string[];
  total: number | null;
  added: number;
  failed: number;
  remaining: number | null;
  cancelled: boolean;
  error: string | null;
  saveStatus: OfferSaveStatus;
  saveError: string | null;
}

export interface OfferOperationSnapshot {
  active: OfferOperationState | null;
  history: Partial<Record<OfferIssuer, OfferOperationState>>;
}

export const OFFER_OPERATION_STORAGE_KEY = "nextcard_offer_operation_snapshot_v1";
export const OFFER_RESULT_FRESHNESS_MS = 15 * 60 * 1000;
export const OFFER_SAVE_FAILURE_GRACE_MS = 5_000;

const ALLOWED_PHASE_TRANSITIONS: Record<OfferOperationPhase, OfferOperationPhase[]> = {
  opening: ["waiting_for_login", "checking", "cancelled", "interrupted", "failed"],
  waiting_for_login: ["checking", "cancelled", "interrupted", "failed"],
  checking: ["waiting_for_login", "ready_to_add", "completed", "cancelled", "interrupted", "failed"],
  ready_to_add: ["checking", "adding", "cancelled", "interrupted", "failed"],
  adding: ["completed", "cancelled", "interrupted", "failed"],
  completed: [],
  cancelled: [],
  interrupted: [],
  failed: [],
};

export function isOfferIssuer(value: unknown): value is OfferIssuer {
  return value === "chase" || value === "amex" || value === "citi" || value === "capitalone";
}

export function isOfferOperationActive(phase: OfferOperationPhase) {
  return (
    phase === "opening"
    || phase === "waiting_for_login"
    || phase === "checking"
    || phase === "ready_to_add"
    || phase === "adding"
  );
}

export function isOfferResultFresh(
  state: OfferOperationState,
  now = Date.now(),
) {
  if (state.phase !== "ready_to_add" || !state.checkedAt) return false;
  const checkedAt = new Date(state.checkedAt).getTime();
  return Number.isFinite(checkedAt) && now - checkedAt <= OFFER_RESULT_FRESHNESS_MS;
}

export function isOfferCompletionContinuing(state: OfferOperationState) {
  return (
    state.phase === "completed"
    && state.added > 0
    && state.cards.length > 0
    && state.selectedCardKeys.length > 0
    && (state.saveStatus === "saving" || state.saveStatus === "saved")
  );
}

export function createOfferOperation(
  issuer: OfferIssuer,
  runId: string,
  now = new Date().toISOString(),
): OfferOperationState {
  return {
    runId,
    issuer,
    phase: "opening",
    ownedTabId: null,
    startedAt: now,
    updatedAt: now,
    checkedAt: null,
    cards: [],
    selectedCardKeys: [],
    total: null,
    added: 0,
    failed: 0,
    remaining: null,
    cancelled: false,
    error: null,
    saveStatus: "not_started",
    saveError: null,
  };
}

export function canTransitionOfferOperation(
  from: OfferOperationPhase,
  to: OfferOperationPhase,
) {
  return from === to || ALLOWED_PHASE_TRANSITIONS[from].includes(to);
}

export function applyOfferOperationPatch(
  current: OfferOperationState,
  changes: Partial<Omit<OfferOperationState, "runId" | "issuer" | "startedAt">>,
  now = new Date().toISOString(),
) {
  if (
    changes.phase
    && !canTransitionOfferOperation(current.phase, changes.phase)
  ) {
    return null;
  }

  return {
    ...current,
    ...changes,
    checkedAt:
      changes.phase === "ready_to_add"
        ? now
        : "checkedAt" in changes
          ? changes.checkedAt ?? null
          : current.checkedAt,
    updatedAt: now,
  } satisfies OfferOperationState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeCard(value: unknown): OfferOperationCard | null {
  if (!isRecord(value) || typeof value.key !== "string" || typeof value.name !== "string") {
    return null;
  }
  const countStatus: OfferCountStatus =
    value.countStatus === "complete" || value.countStatus === "partial"
      ? value.countStatus
      : "unknown";
  return {
    key: value.key.slice(0, 160),
    name: value.name.replace(/\s+/g, " ").trim().slice(0, 80) || "Card",
    lastDigits:
      typeof value.lastDigits === "string" && /^\d{4}$/.test(value.lastDigits)
        ? value.lastDigits
        : null,
    availableCount:
      typeof value.availableCount === "number" && value.availableCount >= 0
        ? value.availableCount
        : null,
    countStatus,
    sharedOfferCount:
      typeof value.sharedOfferCount === "number" && value.sharedOfferCount >= 0
        ? Math.floor(value.sharedOfferCount)
        : null,
  };
}

export function normalizeOfferOperation(value: unknown): OfferOperationState | null {
  if (
    !isRecord(value)
    || typeof value.runId !== "string"
    || !isOfferIssuer(value.issuer)
    || typeof value.startedAt !== "string"
    || typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  const validPhases: OfferOperationPhase[] = [
    "opening",
    "waiting_for_login",
    "checking",
    "ready_to_add",
    "adding",
    "completed",
    "cancelled",
    "interrupted",
    "failed",
  ];
  const phase = validPhases.includes(value.phase as OfferOperationPhase)
    ? value.phase as OfferOperationPhase
    : "interrupted";
  const validSaveStatuses: OfferSaveStatus[] = [
    "not_started",
    "saving",
    "saved",
    "queued_for_retry",
    "failed",
  ];

  return {
    runId: value.runId.slice(0, 100),
    issuer: value.issuer,
    phase,
    ownedTabId:
      typeof value.ownedTabId === "number" && Number.isInteger(value.ownedTabId)
        ? value.ownedTabId
        : null,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : null,
    cards: Array.isArray(value.cards)
      ? value.cards.map(normalizeCard).filter((card): card is OfferOperationCard => Boolean(card))
      : [],
    selectedCardKeys: Array.isArray(value.selectedCardKeys)
      ? value.selectedCardKeys
          .filter((key): key is string => typeof key === "string")
          .slice(0, 20)
          .map((key) => key.slice(0, 160))
      : [],
    total: typeof value.total === "number" && value.total >= 0 ? value.total : null,
    added: typeof value.added === "number" && value.added >= 0 ? value.added : 0,
    failed: typeof value.failed === "number" && value.failed >= 0 ? value.failed : 0,
    remaining:
      typeof value.remaining === "number" && value.remaining >= 0 ? value.remaining : null,
    cancelled: value.cancelled === true,
    error: typeof value.error === "string" ? value.error.slice(0, 240) : null,
    saveStatus: validSaveStatuses.includes(value.saveStatus as OfferSaveStatus)
      ? value.saveStatus as OfferSaveStatus
      : "not_started",
    saveError:
      typeof value.saveError === "string" ? value.saveError.slice(0, 240) : null,
  };
}

export function normalizeOfferOperationSnapshot(value: unknown): OfferOperationSnapshot {
  if (!isRecord(value)) return { active: null, history: {} };

  const history: Partial<Record<OfferIssuer, OfferOperationState>> = {};
  if (isRecord(value.history)) {
    for (const issuer of ["chase", "amex", "citi", "capitalone"] as OfferIssuer[]) {
      const state = normalizeOfferOperation(value.history[issuer]);
      if (state) history[issuer] = state;
    }
  }

  const active = normalizeOfferOperation(value.active);
  return {
    active: active && isOfferOperationActive(active.phase) ? active : null,
    history,
  };
}

export function getOfferOperationStatusText(
  state: OfferOperationState,
  now = Date.now(),
) {
  const issuerName = {
    chase: "Chase",
    amex: "Amex",
    citi: "Citi",
    capitalone: "Capital One",
  }[state.issuer];

  switch (state.phase) {
    case "opening":
      return `Opening ${issuerName}…`;
    case "waiting_for_login":
      return `Finish signing in to ${issuerName}`;
    case "checking":
      return `Checking ${issuerName}…`;
    case "ready_to_add": {
      const completeCards = state.cards.filter((card) => card.countStatus === "complete");
      if (!isOfferResultFresh(state, now)) {
        return completeCards.some((card) => (card.availableCount ?? 0) > 0)
          ? "Previous results are ready to refresh"
          : "No offers at the last check";
      }
      if (completeCards.length === 1) {
        const count = completeCards[0].availableCount ?? 0;
        return count === 0 ? "No new offers found" : `${count} offers found`;
      }
      return completeCards.length > 0
        ? `Offers found on ${completeCards.length} cards`
        : "Offer check needs attention";
    }
    case "adding":
      return state.total == null
        ? `Adding ${issuerName} offers…`
        : `Adding offers — ${state.added} of ${state.total}`;
    case "completed":
      if (state.added > 0 && state.failed > 0) {
        return `${state.added} added · ${state.failed} couldn’t be added`;
      }
      return state.added > 0
        ? `${state.added} ${state.added === 1 ? "offer" : "offers"} added`
        : "No new offers found";
    case "cancelled":
      return state.added > 0
        ? `Stopped · ${state.added} added${state.remaining != null ? `, ${state.remaining} not attempted` : ""}`
        : "Check cancelled";
    case "interrupted":
      return "Check interrupted — try again";
    case "failed":
      return state.error ?? `Couldn’t check ${issuerName}`;
  }
}

export function getOfferSaveStatusText(
  state: OfferOperationState,
  now = Date.now(),
) {
  switch (state.saveStatus) {
    case "saving":
    case "queued_for_retry":
      return "finishing save to nextcard";
    case "saved":
      return "saved to nextcard";
    case "failed": {
      const updatedAt = new Date(state.updatedAt).getTime();
      if (
        Number.isFinite(updatedAt)
        && now - updatedAt < OFFER_SAVE_FAILURE_GRACE_MS
      ) {
        return "finishing save to nextcard";
      }
      return state.saveError ?? "couldn’t save to nextcard";
    }
    case "not_started":
      return "";
  }
}
