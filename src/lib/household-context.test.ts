import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAuth, getAuthGeneration } from "./auth";
import {
  createHouseholdSyncTarget,
  getCurrentHouseholdMemberScope,
  getCurrentHouseholdOperationScope,
  isLegacyHouseholdOperationMode,
  getHouseholdProviderStorageKey,
  getHouseholdRewardsSummariesStorageKey,
  getHouseholdScopedStorageKey,
  householdProviderPushScopeIsCurrent,
  isExtensionVersionSupported,
  parseHouseholdExtensionContext,
  refreshHouseholdContext,
} from "./household-context";

vi.mock("./auth", () => ({
  getAuth: vi.fn(),
  getAuthGeneration: vi.fn(() => 0),
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
    loyaltyReads: true,
    loyaltyWrites: true,
    memberIssuerCardSync: false,
    memberOfferReads: false,
    memberOfferWrites: false,
    combinedReads: false,
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

let stored: Record<string, unknown>;

beforeEach(() => {
  stored = {};
  vi.mocked(getAuthGeneration).mockReturnValue(0);
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
        get: vi.fn(async (key: string | string[]) => Array.isArray(key)
          ? Object.fromEntries(key.map((entry) => [entry, stored[entry]]))
          : { [key]: stored[key] }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
        }),
        remove: vi.fn(async (key: string | string[]) => {
          for (const entry of Array.isArray(key) ? key : [key]) delete stored[entry];
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("household extension context", () => {
  it.each([1, 2])("rejects a vanished selected member with %i surviving members without a caller fence", async (count) => {
    stored.nextcard_household_context_v2 = context;
    stored.nextcard_household_selected_member_v2 = "member-secondary";
    const updated = { ...context, contextRevision: "revision-2", members: [context.members[0], ...count === 2 ? [{ ...context.members[1], id: "different-member" }] : []] };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => updated })));
    await expect(createHouseholdSyncTarget("united")).rejects.toThrow("household_scope_changed");
    await expect(isLegacyHouseholdOperationMode()).resolves.toBe(false);
  });

  it("rejects a changed account before assigning Primary after refresh", async () => {
    stored.nextcard_household_context_v2 = context;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...context, accountScopeId: "other-owner" }) })));
    await expect(createHouseholdSyncTarget("united")).rejects.toThrow("household_scope_changed");
  });

  it("does not use cached context to initiate writes when refresh fails", async () => {
    stored.nextcard_household_context_v2 = context;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    await expect(createHouseholdSyncTarget("united")).rejects.toThrow("household_context_unavailable");
  });
  it("accepts the versioned member and capability contract", () => {
    expect(parseHouseholdExtensionContext(context)).toEqual(context);
  });

  it("rejects malformed members instead of partially exposing the list", () => {
    expect(parseHouseholdExtensionContext({
      ...context,
      members: [...context.members, { id: "broken" }],
    })).toBeNull();
  });

  it("discards a context response when authentication changes in flight", async () => {
    vi.mocked(getAuth)
      .mockResolvedValueOnce({
        token: "old-token",
        name: "Old User",
        email: "old@example.com",
        signedInAt: "2026-09-03T12:00:00.000Z",
      })
      .mockResolvedValueOnce({
        token: "new-token",
        name: "New User",
        email: "new@example.com",
        signedInAt: "2026-09-03T12:01:00.000Z",
      });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => context,
    })));

    await expect(refreshHouseholdContext()).resolves.toBeNull();
    expect(stored.nextcard_household_context_v2).toBeUndefined();
  });

  it("moves a legacy enrolled queue into the authenticated member scope", async () => {
    stored.nextcard_household_context_v2 = {
      ...context,
      capabilities: { ...context.capabilities, memberOfferWrites: true },
    };
    stored.pendingOfferSyncs = [{ runId: "legacy-run", offers: [] }];
    stored.pendingDetectedOfferSyncs = [{ runId: "unsafe-detected-run" }];
    stored.offerUrlCache = { "example.com": [] };

    await expect(getCurrentHouseholdOperationScope()).resolves.toMatchObject({
      accountScopeId: context.accountScopeId,
      memberId: "member-primary",
      memberLifecycleVersion: 1,
    });

    expect(stored[
      "pendingOfferSyncs::account%3Aowner-a::member-primary::1"
    ]).toEqual([
      expect.objectContaining({
        runId: "legacy-run",
        scope: expect.objectContaining({ memberId: "member-primary" }),
      }),
    ]);
    expect(stored.pendingOfferSyncs).toBeUndefined();
    expect(stored.pendingDetectedOfferSyncs).toBeUndefined();
    expect(stored.offerUrlCache).toBeUndefined();
    expect(stored.nextcard_legacy_offer_queue_migration_v2).toMatchObject({
      migratedEnrolledCount: 1,
      discardedDetectedCount: 1,
    });
  });

  it("keeps Primary offers on legacy routes when member offer writes are disabled", async () => {
    stored.nextcard_household_context_v2 = context;
    stored.pendingOfferSyncs = [{ runId: "legacy-primary-run", offers: [] }];

    await expect(getCurrentHouseholdOperationScope()).resolves.toBeNull();
    await expect(getCurrentHouseholdMemberScope()).resolves.toMatchObject({
      memberId: "member-primary",
      memberLifecycleVersion: 1,
    });
    expect(stored.pendingOfferSyncs).toEqual([
      { runId: "legacy-primary-run", offers: [] },
    ]);
  });

  it("does not delete a replacement account's legacy data during migration", async () => {
    stored.nextcard_household_context_v2 = {
      ...context,
      capabilities: { ...context.capabilities, memberOfferWrites: true },
    };
    stored.pendingOfferSyncs = [{ runId: "old-account-run", offers: [] }];
    let releaseScopedWrite: (() => void) | undefined;
    const scopedWriteBlocked = new Promise<void>((resolve) => {
      releaseScopedWrite = resolve;
    });
    vi.mocked(chrome.storage.local.set).mockImplementation(
      async (values: Record<string, unknown>) => {
        Object.assign(stored, values);
        if (
          "pendingOfferSyncs::account%3Aowner-a::member-primary::1" in values
        ) {
          await scopedWriteBlocked;
        }
      },
    );

    const migration = getCurrentHouseholdOperationScope();
    await vi.waitFor(() => expect(stored[
      "pendingOfferSyncs::account%3Aowner-a::member-primary::1"
    ]).toBeDefined());
    stored.pendingOfferSyncs = [{ runId: "new-account-run", offers: [] }];
    vi.mocked(getAuthGeneration).mockReturnValue(1);
    releaseScopedWrite?.();

    await expect(migration).resolves.toMatchObject({ memberId: "member-primary" });
    expect(stored.pendingOfferSyncs).toEqual([
      { runId: "new-account-run", offers: [] },
    ]);
    expect(stored[
      "pendingOfferSyncs::account%3Aowner-a::member-primary::1"
    ]).toBeUndefined();
    expect(stored.nextcard_legacy_offer_queue_migration_v2).toBeUndefined();
  });

  it("keeps legacy Primary offer retries with Primary when a secondary member is selected", async () => {
    stored.nextcard_household_context_v2 = context;
    stored.nextcard_household_selected_member_v2 = "member-secondary";
    stored.pendingOfferSyncs = [{ runId: "legacy-primary-run", offers: [] }];

    await expect(getCurrentHouseholdOperationScope()).resolves.toMatchObject({
      memberId: "member-secondary",
    });

    expect(stored[
      "pendingOfferSyncs::account%3Aowner-a::member-primary::1"
    ]).toEqual([
      expect.objectContaining({
        runId: "legacy-primary-run",
        scope: expect.objectContaining({ memberId: "member-primary" }),
      }),
    ]);
    expect(stored[
      "pendingOfferSyncs::account%3Aowner-a::member-secondary::3"
    ]).toBeUndefined();
  });

  it.each([
    {
      name: "has no activated household",
      value: {
        ...context,
        primaryMemberId: null,
        householdActivated: false,
        capabilities: { householdReads: false, householdWrites: false },
        members: [],
      },
    },
    {
      name: "has household reads disabled",
      value: {
        ...context,
        capabilities: { householdReads: false, householdWrites: false },
        members: [],
      },
    },
  ])("keeps legacy offer state untouched when the account $name", async ({ value }) => {
    stored.nextcard_household_context_v2 = value;
    stored.pendingOfferSyncs = [{ runId: "legacy-run", offers: [] }];
    stored.pendingDetectedOfferSyncs = [{ runId: "legacy-detected-run" }];
    stored.offerUrlCache = { "example.com": [] };

    await expect(getCurrentHouseholdOperationScope()).resolves.toBeNull();

    expect(stored.pendingOfferSyncs).toEqual([
      { runId: "legacy-run", offers: [] },
    ]);
    expect(stored.pendingDetectedOfferSyncs).toEqual([
      { runId: "legacy-detected-run" },
    ]);
    expect(stored.offerUrlCache).toEqual({ "example.com": [] });
    expect(stored.nextcard_legacy_offer_queue_migration_v2).toBeUndefined();
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
      1,
      "united",
    );
    const secondaryKey = getHouseholdProviderStorageKey(
      context.accountScopeId,
      "member-secondary",
      3,
      "united",
    );
    const otherOwnerKey = getHouseholdProviderStorageKey(
      "account:owner-b",
      "member-secondary",
      3,
      "united",
    );

    expect(new Set([primaryKey, secondaryKey, otherOwnerKey]).size).toBe(3);
    expect(getHouseholdProviderStorageKey(
      context.accountScopeId,
      "member-secondary",
      3,
      "united",
    )).not.toBe(getHouseholdProviderStorageKey(
      context.accountScopeId,
      "member-secondary",
      4,
      "united",
    ));
    expect(getHouseholdRewardsSummariesStorageKey(
      context.accountScopeId,
      "member-secondary",
      3,
    )).not.toBe(getHouseholdRewardsSummariesStorageKey(
      context.accountScopeId,
      "member-primary",
      1,
    ));
    expect(getHouseholdScopedStorageKey("pendingOfferSyncs", {
      accountScopeId: context.accountScopeId,
      memberId: "member-secondary",
      memberDisplayName: "Family member",
      memberLifecycleVersion: 3,
      contextRevision: context.contextRevision,
    })).not.toBe(getHouseholdScopedStorageKey("pendingOfferSyncs", {
      accountScopeId: context.accountScopeId,
      memberId: "member-primary",
      memberDisplayName: "Vishal",
      memberLifecycleVersion: 1,
      contextRevision: context.contextRevision,
    }));
  });

  it("freezes the selected member lifecycle in a loyalty operation target", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => context,
    })));
    await chrome.storage.local.set({
      ["nextcard_household_selected_member_v2"]: "member-secondary",
    });

    await expect(createHouseholdSyncTarget("united")).resolves.toMatchObject({
      accountScopeId: context.accountScopeId,
      memberId: "member-secondary",
      memberLifecycleVersion: 3,
      contextRevision: context.contextRevision,
      provider: "united",
    });
  });

  it("fails closed for secondary issuer sync until its capability is enabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => context,
    })));
    await chrome.storage.local.set({
      ["nextcard_household_selected_member_v2"]: "member-secondary",
    });

    await expect(createHouseholdSyncTarget("chase")).rejects.toThrow(
      "issuer_member_sync_unsupported",
    );
  });

  it("rejects a refreshed provider target that no longer matches the frozen scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ ...context, contextRevision: "revision-2" }),
    })));
    await chrome.storage.local.set({
      ["nextcard_household_selected_member_v2"]: "member-secondary",
    });

    await expect(createHouseholdSyncTarget("united", {
      accountScopeId: context.accountScopeId,
      memberId: "member-secondary",
      memberDisplayName: "Family member",
      memberLifecycleVersion: 3,
      contextRevision: context.contextRevision,
    })).rejects.toThrow("household_scope_changed");
  });

  it("does not fall back to legacy Primary when the frozen member disappears", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...context,
        contextRevision: "revision-2",
        members: [context.members[0]],
      }),
    })));

    await expect(createHouseholdSyncTarget("united", {
      accountScopeId: context.accountScopeId,
      memberId: "member-secondary",
      memberDisplayName: "Family member",
      memberLifecycleVersion: 3,
      contextRevision: context.contextRevision,
    })).rejects.toThrow("household_scope_changed");
  });

  it.each([
    {
      provider: "united" satisfies Parameters<typeof createHouseholdSyncTarget>[0],
      capabilities: { ...context.capabilities, loyaltyWrites: false },
    },
    {
      provider: "chase" satisfies Parameters<typeof createHouseholdSyncTarget>[0],
      capabilities: { ...context.capabilities, memberIssuerCardSync: false },
    },
  ] satisfies Array<{
    provider: Parameters<typeof createHouseholdSyncTarget>[0];
    capabilities: typeof context.capabilities;
  }>)("keeps legacy Primary $provider sync valid through its post-network fence", async ({
    provider,
    capabilities,
  }) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...context,
        capabilities,
      }),
    })));

    await expect(createHouseholdSyncTarget(provider)).resolves.toBeNull();
    const frozenScope = await getCurrentHouseholdMemberScope();
    expect(frozenScope).toMatchObject({ memberId: "member-primary" });
    expect(householdProviderPushScopeIsCurrent(
      null,
      frozenScope,
      await getCurrentHouseholdMemberScope(),
      false,
    )).toBe(true);
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
