import { describe, expect, it } from "vitest";

import {
  hydrateStoredProviderStates,
  normalizeOnboardingFlags,
} from "./state";

describe("popup state helpers", () => {
  it("normalizes onboarding flags from storage", () => {
    expect(
      normalizeOnboardingFlags({
        disclosureAccepted: 1,
        consentGiven: "yes",
        firstSyncCompleted: 0,
      }),
    ).toEqual({
      disclosureAccepted: true,
      consentGiven: true,
      firstSyncCompleted: false,
    });
  });

  it("keeps storage metadata while dropping invalid provider payloads", () => {
    const states = hydrateStoredProviderStates({
      provider_chase: {
        status: "done",
        data: { broken: true },
        error: null,
        lastSyncedAt: "2026-04-09T12:00:00.000Z",
      },
      provider_marriott: {
        status: "error",
        data: null,
        error: "Timed out",
        lastSyncedAt: null,
      },
    });

    expect(states.chase).toEqual({
      status: "done",
      data: null,
      error: null,
      lastSyncedAt: "2026-04-09T12:00:00.000Z",
    });
    expect(states.marriott).toEqual({
      status: "error",
      data: null,
      error: "Timed out",
      lastSyncedAt: null,
    });
    expect(states.hyatt.status).toBe("idle");
    expect(states.hyatt.data).toBeNull();
  });
});
