// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type {
  ExtensionRewardsSummary,
  ProviderSyncState,
} from "../../lib/types";
import {
  getConnectedTravelProviderIds,
  hasConnectedRewards,
} from "./home-state";

const summary: ExtensionRewardsSummary = {
  provider: "chase",
  loyaltyAccountId: "account-1",
  rewardsProgramId: "program-1",
  programSlug: "chase",
  programName: "Chase Ultimate Rewards",
  iconUrl: null,
  pointsBalance: 100_000,
  statusLevel: null,
  cardCount: 2,
  benefitCount: 1,
  lastSyncedAt: "2026-07-28T12:00:00.000Z",
  dashboardPath: "/dashboard/rewards?program=chase",
};

const syncedState: ProviderSyncState = {
  status: "done",
  data: null,
  error: null,
  lastSyncedAt: "2026-07-28T12:00:00.000Z",
  progressMessage: null,
};

describe("hasConnectedRewards", () => {
  it("keeps the setup intro for a true first-time user", () => {
    expect(hasConnectedRewards({}, [], false)).toBe(false);
  });

  it("recognizes server summaries after an extension reinstall", () => {
    expect(hasConnectedRewards({}, [summary], false)).toBe(true);
  });

  it("recognizes completed local sync state", () => {
    expect(
      hasConnectedRewards({ chase: syncedState }, [], false),
    ).toBe(true);
  });

  it("preserves the completed onboarding state between sessions", () => {
    expect(hasConnectedRewards({}, [], true)).toBe(true);
  });
});

describe("getConnectedTravelProviderIds", () => {
  it("returns connected airline and hotel programs in display order", () => {
    const summaries: ExtensionRewardsSummary[] = [
      { ...summary, provider: "hilton", programName: "Hilton Honors" },
      { ...summary, provider: "chase" },
      { ...summary, provider: "aa", programName: "American Airlines AAdvantage" },
      { ...summary, provider: "aa", loyaltyAccountId: "account-2" },
    ];

    expect(getConnectedTravelProviderIds(summaries, [])).toEqual([
      "aa",
      "hilton",
    ]);
  });

  it("excludes travel programs locked by the current plan", () => {
    const summaries: ExtensionRewardsSummary[] = [
      { ...summary, provider: "aa" },
      { ...summary, provider: "hilton" },
    ];

    expect(getConnectedTravelProviderIds(summaries, ["hilton"])).toEqual([
      "aa",
    ]);
  });
});


it("lets a saved program cancel its active sync directly from the summary card", async () => {
  document.documentElement.innerHTML = readFileSync(`${process.cwd()}/src/popup/popup.html`, "utf8");
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path }, storage: { local: { set: vi.fn() } } });
  try {
    const { createHomeRenderer } = await import("./render-home");
    const { createRuntimeStateStore } = await import("../../background/core/runtime-state");
    const states = createRuntimeStateStore().states;
    states.capitalone = { ...states.capitalone, ...syncedState, status: "waiting_for_login" };
    const onSummaryCancelRequested = vi.fn();
    const onSummarySyncRequested = vi.fn();
    const providerList = document.createElement("div");
    const render = createHomeRenderer({
      providerList, tourTooltip: document.createElement("div"),
      getFirstSyncCompleted: () => true, getExtensionProfile: () => null,
      getRewardsSummaries: () => [{ ...summary, provider: "capitalone", programName: "Capital One Miles" }],
      getSyncAllState: () => ({ status: "idle", providerIds: [], currentProviderId: null, processedCount: 0, failedCount: 0, startedAt: null, updatedAt: null }),
      markFirstSyncCompleted() {}, onProviderSelected() {}, onLockedProviderSelected() {},
      onSummarySelected() {}, onSummarySyncRequested, onSummaryCancelRequested,
      onSyncAllRequested() {}, onSyncAllCancelRequested() {},
    });
    render(states);
    expect(providerList.querySelector(".rewards-summary-secondary")).toBeNull();
    expect(providerList.querySelectorAll(".rewards-sync-stop")).toHaveLength(1);
    const stop = providerList.querySelector(".rewards-summary-header .rewards-sync-stop");
    if (!(stop instanceof HTMLButtonElement)) throw new Error("Missing stop icon");
    expect(stop.getAttribute("aria-label")).toBe("Stop Capital One sync");
    stop.click();
    expect(onSummaryCancelRequested).toHaveBeenCalledWith("capitalone");
    expect(onSummaryCancelRequested).toHaveBeenCalledTimes(1);
    expect(onSummarySyncRequested).not.toHaveBeenCalled();
    states.capitalone.status = "done";
    render(states);
    const retry = providerList.querySelector(".rewards-summary-secondary");
    if (!(retry instanceof HTMLButtonElement)) throw new Error("Missing sync action");
    expect(retry.textContent).toBe("Sync again");
    expect(providerList.querySelector(".rewards-summary-header .rewards-sync-stop")).toBeNull();
    states.aa.status = "waiting_for_login";
    render(states);
    const firstSyncStop = providerList.querySelector(".provider-card-row > .rewards-sync-stop");
    if (!(firstSyncStop instanceof HTMLButtonElement)) throw new Error("Missing first-sync stop icon");
    firstSyncStop.click();
    expect(onSummaryCancelRequested).toHaveBeenCalledWith("aa");
    retry.click();
    expect(onSummarySyncRequested).toHaveBeenCalledWith("capitalone");
  } finally { vi.unstubAllGlobals(); }
});
