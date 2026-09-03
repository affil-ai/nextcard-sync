import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth } from "./auth";
import {
  createHouseholdSyncTarget,
  getHouseholdProviderStorageKey,
  getHouseholdRewardsSummariesStorageKey,
  isExtensionVersionSupported,
  parseHouseholdExtensionContext,
} from "./household-context";

vi.mock("./auth", () => ({
  getAuth: vi.fn(),
}));

const context = {
  protocolVersion: 2,
  minimumExtensionVersion: "0.8.1",
  recommendedExtensionVersion: "0.8.1",
  accountScopeId: "account:owner-a",
  contextRevision: "revision-1",
  primaryMemberId: "member-primary",
  householdActivated: true,
  capabilities: {
    householdReads: true,
    householdWrites: true,
  },
  members: [
    {
      id: "member-primary",
      displayName: "Vishal",
      isPrimary: true,
      lifecycleVersion: 1,
    },
    {
      id: "member-secondary",
      displayName: "Family member",
      isPrimary: false,
      lifecycleVersion: 3,
    },
  ],
};

beforeEach(() => {
  const stored: Record<string, unknown> = {};
  vi.mocked(getAuth).mockResolvedValue({
    token: "token",
    name: "Test User",
    email: "test@example.com",
    signedInAt: "2026-09-03T12:00:00.000Z",
  });
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "0.8.1" }),
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
        }),
        remove: vi.fn(async (key: string) => {
          delete stored[key];
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("household extension context", () => {
  it("accepts the versioned member and capability contract", () => {
    expect(parseHouseholdExtensionContext(context)).toEqual(context);
  });

  it("rejects malformed members instead of partially exposing the list", () => {
    expect(parseHouseholdExtensionContext({
      ...context,
      members: [...context.members, { id: "broken" }],
    })).toBeNull();
  });

  it("enforces the server minimum extension version", () => {
    expect(isExtensionVersionSupported("0.8.1", "0.8.1")).toBe(true);
    expect(isExtensionVersionSupported("0.8.2", "0.8.1")).toBe(true);
    expect(isExtensionVersionSupported("1.0.0", "0.8.1")).toBe(true);
    expect(isExtensionVersionSupported("0.8.0", "0.8.1")).toBe(false);
    expect(isExtensionVersionSupported("invalid", "0.8.1")).toBe(false);
  });

  it("isolates provider state by account, member, and provider", () => {
    const primaryKey = getHouseholdProviderStorageKey(
      context.accountScopeId,
      "member-primary",
      "united",
    );
    const secondaryKey = getHouseholdProviderStorageKey(
      context.accountScopeId,
      "member-secondary",
      "united",
    );
    const otherOwnerKey = getHouseholdProviderStorageKey(
      "account:owner-b",
      "member-secondary",
      "united",
    );

    expect(new Set([primaryKey, secondaryKey, otherOwnerKey]).size).toBe(3);
    expect(getHouseholdRewardsSummariesStorageKey(
      context.accountScopeId,
      "member-secondary",
    )).not.toBe(getHouseholdRewardsSummariesStorageKey(
      context.accountScopeId,
      "member-primary",
    ));
  });

  it("keeps legacy Primary sync available when household writes are disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...context,
        capabilities: { householdReads: true, householdWrites: false },
      }),
    })));

    await expect(createHouseholdSyncTarget("united")).resolves.toBeNull();
  });

  it("fails closed for a secondary member when household writes are disabled", async () => {
    const disabledContext = {
      ...context,
      capabilities: { householdReads: true, householdWrites: false },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => disabledContext,
    })));
    await chrome.storage.local.set({
      ["nextcard_household_selected_member_v2"]: "member-secondary",
    });

    await expect(createHouseholdSyncTarget("united")).rejects.toThrow(
      "extension_writes_disabled",
    );
  });
});
