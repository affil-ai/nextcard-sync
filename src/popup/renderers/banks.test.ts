// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createBankRenderers } from "./banks";
import type { ChaseURData, ProviderSyncState } from "../../lib/types";

it("distinguishes saved cards from a pending product change and clears the summary during another sync", () => {
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/src/popup/popup.html`, "utf8");
  const renderers = createBankRenderers(async () => true);
  const state: ProviderSyncState<ChaseURData> = {
    status: "done", data: null, error: null, progressMessage: null,
    lastSyncedAt: "2026-10-19T12:00:00Z", backendSyncStatus: "saved",
    cardSync: { created: 0, existing: 2, productChangesToReview: 1 },
  };
  renderers.renderChase(state);
  const result = document.getElementById("chaseErrorContainer");
  expect(result?.textContent).toContain("2 cards synced · 1 product change to review");
  expect(result?.querySelector("a")?.getAttribute("href")).toContain("/dashboard/cards");
  renderers.renderChase({ ...state, status: "extracting", progressMessage: "Checking cards" });
  expect(result?.textContent).not.toContain("product change to review");
});
