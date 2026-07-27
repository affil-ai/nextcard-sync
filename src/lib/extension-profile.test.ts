import { describe, expect, it } from "vitest";
import { normalizeExtensionProfile } from "./extension-profile";

describe("extension profile UI rollout flag", () => {
  const baseProfile = {
    accountLevel: "free",
    allowedProviders: ["chase"],
    lockedProviders: [],
    upgradeUrl: "/upgrade",
  };

  it("keeps the flag undefined when the server has not enabled the new shell", () => {
    expect(normalizeExtensionProfile(baseProfile)?.offersFirstUiEnabled).toBeUndefined();
  });

  it("accepts explicit rollout and rollback values", () => {
    expect(normalizeExtensionProfile({
      ...baseProfile,
      offersFirstUiEnabled: true,
    })?.offersFirstUiEnabled).toBe(true);
    expect(normalizeExtensionProfile({
      ...baseProfile,
      offersFirstUiEnabled: false,
    })?.offersFirstUiEnabled).toBe(false);
  });
});
