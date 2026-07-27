import { describe, expect, it } from "vitest";
import {
  AMEX_MAX_RETRY_AFTER_MS,
  classifyAmexEnrollmentResponse,
  evaluateAmexPrimaryResult,
  parseAmexRetryAfterMs,
  type AmexPrimaryFallbackState,
} from "./amex-enrollment-policy";

describe("Amex enrollment fallback policy", () => {
  it("accepts a confirmed enrollment response", () => {
    const result = classifyAmexEnrollmentResponse({
      endpoint: "card_account",
      status: 200,
      body: { isEnrolled: true },
    });
    expect(result.result).toBe("added");
    expect(result.failureReason).toBeUndefined();
  });

  it("does not fall back for an offer already enrolled elsewhere", () => {
    const state: AmexPrimaryFallbackState = {
      consecutiveFailures: 0,
      useOffersHubFallback: false,
    };
    const result = classifyAmexEnrollmentResponse({
      endpoint: "card_account",
      status: 200,
      body: { isEnrolled: false, explanationCode: "PZN4107" },
    });
    expect(evaluateAmexPrimaryResult(state, result).fallbackNow).toBe(false);
  });

  it("falls back immediately after rate limiting", () => {
    const state: AmexPrimaryFallbackState = {
      consecutiveFailures: 0,
      useOffersHubFallback: false,
    };
    const result = classifyAmexEnrollmentResponse({
      endpoint: "card_account",
      status: 429,
      body: null,
      retryAfter: "2",
    });
    const evaluated = evaluateAmexPrimaryResult(state, result);
    expect(evaluated.fallbackNow).toBe(true);
    expect(evaluated.state.useOffersHubFallback).toBe(true);
    expect(result.retryAfterMs).toBe(2_000);
  });

  it("switches after ten consecutive primary failures", () => {
    const result = classifyAmexEnrollmentResponse({
      endpoint: "card_account",
      status: 500,
      body: null,
    });
    let state: AmexPrimaryFallbackState = {
      consecutiveFailures: 0,
      useOffersHubFallback: false,
    };
    let fallbackNow = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const evaluated = evaluateAmexPrimaryResult(state, result);
      state = evaluated.state;
      fallbackNow = evaluated.fallbackNow;
    }
    expect(fallbackNow).toBe(true);
    expect(state.useOffersHubFallback).toBe(true);
  });

  it("parses date Retry-After values and caps long waits", () => {
    const now = Date.parse("2026-07-27T20:00:00Z");
    expect(
      parseAmexRetryAfterMs("Sun, 27 Jul 2026 20:00:05 GMT", now),
    ).toBe(5_000);
    expect(parseAmexRetryAfterMs("120", now)).toBe(AMEX_MAX_RETRY_AFTER_MS);
  });
});
