import { describe, expect, it } from "vitest";

import { providerGroups } from "./provider-groups";
import {
  buildProviderContentScripts,
  getProviderHostPermissions,
  providerIds,
  providerRegistry,
} from "./provider-registry";

describe("providerRegistry", () => {
  it("covers every provider exactly once across the grouped order", () => {
    const groupedIds = providerGroups.flatMap((group) => group.ids);

    expect(new Set(providerIds).size).toBe(providerIds.length);
    expect(new Set(groupedIds)).toEqual(new Set(providerIds));
  });

  it("keeps the metadata required by popup and worker in one place", () => {
    for (const providerId of providerIds) {
      const definition = providerRegistry[providerId];
      expect(definition.id).toBe(providerId);
      expect(definition.group.length).toBeGreaterThan(0);
      expect(definition.iconPath).toMatch(/^src\/icons\/.+\.png$/);
      expect(definition.manifestMatches.length).toBeGreaterThan(0);
      expect(definition.contentScriptPath).toMatch(/^src\/content-scripts\/.+\.ts$/);
    }
  });

  it("keeps Chase on the v1 production path", () => {
    expect(providerRegistry.chase.syncStrategy).toBe("chase-v1");
    expect(providerRegistry.chase.contentScriptPath).toBe(
      "src/content-scripts/chase.ts",
    );
    expect(providerRegistry.chase.benefitsContentScriptPath).toBe(
      "src/content-scripts/chase-benefits.ts",
    );
  });

  it("derives host permissions and content scripts from the registry", () => {
    expect(getProviderHostPermissions(providerRegistry.bilt)).toContain(
      "https://www.biltrewards.com/*",
    );

    const contentScripts = buildProviderContentScripts();
    expect(contentScripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matches: ["https://ultimaterewardspoints.chase.com/*"],
          js: ["src/content-scripts/chase.ts"],
        }),
        expect.objectContaining({
          matches: ["https://secure.chase.com/*"],
          js: ["src/content-scripts/chase-benefits.ts"],
        }),
      ]),
    );
  });
});
