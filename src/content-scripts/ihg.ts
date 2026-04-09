/**
 * Content script for ihg.com (IHG One Rewards).
 * Runs in ISOLATED WORLD.
 */

import type { IHGLoyaltyData, LoginState } from "../lib/types";
import { createContentScriptRunControl } from "../lib/content-script-run-control";
import { showOverlay, updateOverlay } from "../lib/overlay";

const runControl = createContentScriptRunControl("ihg");

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() ?? "";
}

function parseIntSafe(value: string | null | undefined): number | null {
  const digits = value?.replace(/[^\d]/g, "") ?? "";
  if (!digits) return null;
  const parsed = parseInt(digits, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function findTextMatch(pattern: RegExp) {
  const text = normalizeText(document.body.innerText);
  return text.match(pattern);
}

function findByText(selector: string, pattern: RegExp) {
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .find((element) => pattern.test(normalizeText(element.innerText || element.textContent)));
}

function getTrackerContainerText() {
  const nightsButton = findByText("button", /^By nights$/i);
  if (!nightsButton) return "";

  // The tracker is nested and unlabelled, so climb until the text clearly scopes to that region.
  let candidate: HTMLElement | null = nightsButton.parentElement;
  while (candidate) {
    const text = normalizeText(candidate.innerText);
    if (text.includes("Current status") && text.includes("Here's your status tracker")) {
      return text;
    }
    candidate = candidate.parentElement;
  }

  return "";
}

function getMilestoneContainerText() {
  const rewardsButton = findByText("button", /See reward options/i);
  if (!rewardsButton) return "";

  // This section has repeated "nights" copy elsewhere on the page, so scope to the milestone card.
  let candidate: HTMLElement | null = rewardsButton.parentElement;
  while (candidate) {
    const text = normalizeText(candidate.innerText);
    if (text.includes("Milestone Rewards") && text.includes("next milestone")) {
      return text;
    }
    candidate = candidate.parentElement;
  }

  return "";
}

function detectLoginState(): LoginState {
  const url = window.location.href.toLowerCase();
  const passwordInput = document.querySelector('input[type="password"]');
  const signOutLink = findByText("a, button", /^Sign out$/i);
  const memberNumberMatch = findTextMatch(/Member\s*#\s*(\d{6,})/i);

  // The sign-in page can remember the email and even greet the user, so the password field wins.
  if (url.includes("/sign-in") || (passwordInput && !signOutLink && !memberNumberMatch)) {
    return "logged_out";
  }

  if (url.includes("/account-mgmt/") && (signOutLink || memberNumberMatch)) {
    return "logged_in";
  }

  return "unknown";
}

function hasRenderableAccountData(data: IHGLoyaltyData) {
  return typeof data.pointsBalance === "number"
    && !!data.eliteStatus
    && !!data.memberNumber;
}

async function waitForAccountContent(attemptId: string, maxWaitMs = 20000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    if (detectLoginState() === "logged_in") {
      const hasMemberNumber = !!findTextMatch(/Member\s*#\s*\d{6,}/i);
      const hasPoints = !!findTextMatch(/YOUR POINTS\s*[\d,]+/i);
      if (hasMemberNumber && hasPoints) {
        return true;
      }
    }

    await runControl.sleep(250, attemptId);
  }

  return false;
}

async function readProgressFromTracker(attemptId: string) {
  const nightsButton = findByText("button", /^By nights$/i);
  const pointsButton = findByText("button", /^By points$/i);

  if (nightsButton) {
    nightsButton.click();
    await runControl.sleep(250, attemptId);
  }

  const nightsText = getTrackerContainerText();

  if (pointsButton) {
    pointsButton.click();
    await runControl.sleep(250, attemptId);
  }

  const pointsText = getTrackerContainerText();

  return { nightsText, pointsText };
}

async function scrapeAccountPage(attemptId: string) {
  const progress = await readProgressFromTracker(attemptId);
  const bodyText = normalizeText(document.body.innerText);
  const milestoneText = getMilestoneContainerText();

  const memberName = findTextMatch(/Hello\s+([^,]+),/i)?.[1]?.trim() ?? null;
  const eliteStatus = Array.from(document.querySelectorAll<HTMLElement>("h1, h2, h3"))
    .map((heading) => normalizeText(heading.innerText))
    .find((text) => /(Club Member|Silver Elite|Gold Elite|Platinum Elite|Diamond Elite)/i.test(text)) ?? null;

  const nightsMatch = progress.nightsText.match(/(\d[\d,]*)\s+nights\s+(\d[\d,]*)\s+more to\s+([A-Za-z ]+Elite)/i);
  const pointsBalance = parseIntSafe(bodyText.match(/YOUR POINTS\s*([\d,]+)/i)?.[1] ?? null);
  const memberNumber = bodyText.match(/Member\s*#\s*(\d{6,})/i)?.[1] ?? null;
  const milestoneMatch = milestoneText.match(/(\d[\d,]*)\s+nights to next milestone/i);
  const nextMilestoneRewardAt = milestoneText.match(/Choose your first reward at\s+(\d[\d,]*)/i)?.[1] ?? null;

  const data: IHGLoyaltyData = {
    pointsBalance,
    eliteStatus,
    memberName,
    memberNumber,
    qualifyingNights: parseIntSafe(nightsMatch?.[1] ?? null),
    nightsToNextTier: parseIntSafe(nightsMatch?.[2] ?? null),
    nextTierName: nightsMatch?.[3]?.trim() ?? null,
    milestoneNightsToNext: parseIntSafe(milestoneMatch?.[1] ?? null),
    nextMilestoneRewardAt: parseIntSafe(nextMilestoneRewardAt),
  };

  // The points tracker is useful context for humans even when the first tier lacks a visible target.
  if (progress.pointsText) {
    console.log("[NextCard IHG] Points tracker:", progress.pointsText);
  }

  console.log("[NextCard IHG] Scraped data:", data);
  return data;
}

async function runExtraction(attemptId: string) {
  const loginState = detectLoginState();
  await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: loginState });

  if (loginState !== "logged_in") {
    showOverlay("waiting_for_login", "ihg");
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    return;
  }

  updateOverlay("extracting", "ihg");
  const hasContent = await waitForAccountContent(attemptId);
  if (!hasContent) {
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "error",
      data: null,
      error: "IHG account page did not finish loading",
    });
    return;
  }

  runControl.throwIfCancelled(attemptId);
  const data = await scrapeAccountPage(attemptId);
  if (!hasRenderableAccountData(data)) {
    // Refuse to mark success if the page fell back to a partial shell or expired session.
    await runControl.sendMessage(attemptId, { type: "LOGIN_STATE", state: "logged_out" });
    await runControl.sendMessage(attemptId, {
      type: "STATUS_UPDATE",
      status: "waiting_for_login",
      data: null,
      error: null,
    });
    showOverlay("waiting_for_login", "ihg");
    return;
  }

  await runControl.sendMessage(attemptId, { type: "EXTRACTION_DONE", data });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (runControl.handleAbort(message)) {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "START_EXTRACTION") {
    if (typeof message.attemptId !== "string") {
      sendResponse({ ok: false });
      return true;
    }

    runControl.beginAttempt(message.attemptId);
    void runExtraction(message.attemptId);
    sendResponse({ ok: true });
  }

  if (message.type === "GET_LOGIN_STATE") {
    sendResponse({ state: detectLoginState() });
  }

  return true;
});

const initialState = detectLoginState();
chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "ihg" }, (response) => {
  const status = response?.status;
  if (status === "extracting" || (status === "detecting_login" && initialState === "logged_in")) {
    showOverlay("extracting", "ihg");
  } else if ((status === "waiting_for_login" || status === "detecting_login") && initialState !== "logged_in") {
    showOverlay("waiting_for_login", "ihg");
  }
});
chrome.runtime.sendMessage({ type: "LOGIN_STATE", provider: "ihg", state: initialState }).catch(() => {});
console.log("[NextCard IHG] Content script loaded. Login state:", initialState);
