export type AmexEnrollmentEndpoint = "card_account" | "offers_hub";

export type AmexEnrollmentFailureReason =
  | "already_enrolled_elsewhere"
  | "invalid_identifier"
  | "rate_limited"
  | "network_or_cors"
  | "enrollment_failed_other";

export interface AmexEnrollmentResult {
  result: "added" | "skipped" | "failed" | "unknown";
  endpoint: AmexEnrollmentEndpoint;
  status: number;
  purpose?: unknown;
  message?: unknown;
  explanationCode?: unknown;
  error?: string;
  failureReason?: AmexEnrollmentFailureReason;
  retryAfterMs?: number;
}

export interface AmexPrimaryFallbackState {
  consecutiveFailures: number;
  useOffersHubFallback: boolean;
}

export const AMEX_PRIMARY_FAILURE_THRESHOLD = 10;
export const AMEX_DEFAULT_RATE_LIMIT_DELAY_MS = 3_000;
export const AMEX_MAX_RETRY_AFTER_MS = 15_000;

function isEnrolledValue(value: unknown) {
  return value === true || value === "true" || value === "TRUE";
}

export function parseAmexRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
) {
  if (!value) return null;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? Math.max(0, Math.ceil(seconds * 1_000))
    : Math.max(0, Date.parse(value) - now);
  if (!Number.isFinite(milliseconds)) return null;
  return Math.min(milliseconds, AMEX_MAX_RETRY_AFTER_MS);
}

export function classifyAmexEnrollmentResponse(input: {
  endpoint: AmexEnrollmentEndpoint;
  status: number;
  body: Record<string, unknown> | null;
  error?: string;
  retryAfter?: string | null;
}): AmexEnrollmentResult {
  const { endpoint, status, body, error } = input;
  const responseStatus = body?.status;
  const purpose =
    typeof responseStatus === "object" && responseStatus !== null
      ? (responseStatus as Record<string, unknown>).purpose
      : undefined;
  const message =
    typeof responseStatus === "object" && responseStatus !== null
      ? (responseStatus as Record<string, unknown>).message
      : undefined;
  const explanationCode = body?.explanationCode;

  if (status === 200 && (isEnrolledValue(body?.isEnrolled) || purpose === "SUCCESS")) {
    return { result: "added", endpoint, status, purpose, message, explanationCode };
  }
  if (status === 200 && explanationCode === "PZN4107") {
    return {
      result: "failed",
      endpoint,
      status,
      purpose,
      message,
      explanationCode,
      failureReason: "already_enrolled_elsewhere",
    };
  }
  if (status === 400 && explanationCode === "PZN2001") {
    return {
      result: "failed",
      endpoint,
      status,
      purpose,
      message,
      explanationCode,
      failureReason: "invalid_identifier",
    };
  }
  if (status === 429) {
    return {
      result: "failed",
      endpoint,
      status,
      purpose,
      message,
      explanationCode,
      failureReason: "rate_limited",
      retryAfterMs:
        parseAmexRetryAfterMs(input.retryAfter)
        ?? AMEX_DEFAULT_RATE_LIMIT_DELAY_MS,
    };
  }
  if (status === 0) {
    return {
      result: "unknown",
      endpoint,
      status,
      purpose,
      message,
      explanationCode,
      error,
      failureReason: "network_or_cors",
    };
  }
  return {
    result: "failed",
    endpoint,
    status,
    purpose,
    message,
    explanationCode,
    error,
    failureReason: "enrollment_failed_other",
  };
}

export function evaluateAmexPrimaryResult(
  current: AmexPrimaryFallbackState,
  result: AmexEnrollmentResult,
): { state: AmexPrimaryFallbackState; fallbackNow: boolean } {
  if (result.result === "added") {
    return {
      state: { consecutiveFailures: 0, useOffersHubFallback: false },
      fallbackNow: false,
    };
  }

  if (
    result.failureReason === "already_enrolled_elsewhere"
    || result.failureReason === "invalid_identifier"
  ) {
    return { state: current, fallbackNow: false };
  }

  if (
    result.failureReason === "rate_limited"
    || result.failureReason === "network_or_cors"
  ) {
    return {
      state: {
        consecutiveFailures: current.consecutiveFailures,
        useOffersHubFallback: true,
      },
      fallbackNow: true,
    };
  }

  const consecutiveFailures = current.consecutiveFailures + 1;
  const fallbackNow = consecutiveFailures >= AMEX_PRIMARY_FAILURE_THRESHOLD;
  return {
    state: {
      consecutiveFailures,
      useOffersHubFallback: current.useOffersHubFallback || fallbackNow,
    },
    fallbackNow,
  };
}
