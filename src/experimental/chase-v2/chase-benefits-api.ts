/**
 * Alternative Chase benefits scraper that reads Chase's own JSON APIs
 * instead of navigating through each benefit detail page one by one.
 */

import { createContentScriptRunControl } from "../../lib/content-script-run-control";
import { showOverlay } from "../../lib/overlay";
import {
  extractAllChaseAccountMetadata,
  extractChaseAccountMetadata,
  extractChaseApiBenefits,
  isChaseAccountMetadata,
  mapChaseBenefitsFromApi,
} from "./chase-benefits-api-helpers";

const runControl = createContentScriptRunControl("chase");
const ACCOUNT_METADATA_CACHE_PREFIX = "nextcard.chase.account-metadata";

function isBenefitsPage() {
  return window.location.href.toLowerCase().includes("benefits");
}

function getAccountIdFromUrl() {
  const currentUrl = new URL(window.location.href);
  const hashParams = new URLSearchParams(currentUrl.hash.split("?")[1] ?? "");
  return hashParams.get("account") ?? currentUrl.searchParams.get("account");
}

function getCommonHeaders() {
  return {
    accept: "application/json, text/plain, */*",
    "x-jpmc-csrf-token": "NONE",
    "x-jpmc-channel": "id=C30",
  };
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
  });

  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }

  return response.json();
}

function getAccountMetadataCacheKey(accountId: string | null) {
  return `${ACCOUNT_METADATA_CACHE_PREFIX}:${accountId ?? "default"}`;
}

function readCachedAccountMetadata(accountId: string | null) {
  try {
    const raw = window.sessionStorage.getItem(getAccountMetadataCacheKey(accountId));
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    return isChaseAccountMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedAccountMetadata(accountId: string | null, metadata: unknown) {
  if (!isChaseAccountMetadata(metadata)) return;

  try {
    // We keep this page-session scoped so manual syncs do not keep re-posting
    // to Chase for metadata the UI already asked for earlier in the same session.
    window.sessionStorage.setItem(getAccountMetadataCacheKey(accountId), JSON.stringify(metadata));
  } catch {
    // Storage access can fail in hardened browser contexts, so caching stays best-effort.
  }
}

function writeCachedAccountMetadataBatch(allMetadata: unknown[]) {
  for (const metadata of allMetadata) {
    if (!isChaseAccountMetadata(metadata)) continue;
    writeCachedAccountMetadata(String(metadata.digitalAccountIdentifier), metadata);
  }
}

async function fetchChaseAccountMetadata(accountId: string | null) {
  const cachedMetadata = readCachedAccountMetadata(accountId);
  if (cachedMetadata) {
    return cachedMetadata;
  }

  // Chase already exposes the current card metadata in app bootstrap data,
  // so we reuse that instead of hard-coding product codes per card.
  const appData = await fetchJson("/svc/rl/accounts/l4/v1/app/data/list", {
    method: "POST",
    headers: {
      ...getCommonHeaders(),
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
  });

  const allMetadata = extractAllChaseAccountMetadata(appData);
  writeCachedAccountMetadataBatch(allMetadata);

  const metadata = extractChaseAccountMetadata(appData, accountId);
  writeCachedAccountMetadata(accountId, metadata);
  return metadata;
}

async function fetchChaseBenefits(accountId: string | null) {
  const accountMetadata = await fetchChaseAccountMetadata(accountId);
  if (!accountMetadata) {
    throw new Error("Could not determine Chase account metadata for benefits API");
  }

  const benefitsResponse = await fetchJson(
    "/svc/rr/accounts/secure/gateway/ccb/loyalty/benefits-management/digital-benefits-lists/v3/benefits-lists",
    {
      headers: {
        ...getCommonHeaders(),
        "path-params": JSON.stringify([accountMetadata]),
      },
    },
  );

  return mapChaseBenefitsFromApi(extractChaseApiBenefits(benefitsResponse));
}

async function runBenefitsExtraction(attemptId: string) {
  if (!isBenefitsPage()) {
    await runControl.sendMessage(attemptId, { type: "CHASE_BENEFITS_DONE", benefits: [] });
    return;
  }

  const accountId = getAccountIdFromUrl();
  console.log("[NextCard Chase Benefits API] Starting extraction for account:", accountId);

  // The worker now waits for the benefits route before triggering extraction, so
  // we can fetch immediately instead of paying another fixed settle per card.
  const benefits = await fetchChaseBenefits(accountId);
  runControl.throwIfCancelled(attemptId);

  console.log("[NextCard Chase Benefits API] Scraped benefits:", benefits);
  await runControl.sendMessage(attemptId, { type: "CHASE_BENEFITS_DONE", benefits });
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
    runBenefitsExtraction(message.attemptId).catch((error) => {
      console.error("[NextCard Chase Benefits API] Extraction failed:", error);
      runControl.sendMessage(message.attemptId, { type: "CHASE_BENEFITS_DONE", benefits: [] }).catch(() => {
        // Best-effort fallback so the background worker is not left hanging.
      });
    });
    sendResponse({ ok: true });
  }
  return true;
});

chrome.runtime.sendMessage({ type: "GET_PROVIDER_STATUS", provider: "chase" }, (response) => {
  const status = response?.status;

  if (status === "waiting_for_login" || status === "detecting_login") {
    showOverlay("waiting_for_login", "chase");
  } else if (status === "extracting") {
    showOverlay("extracting", "chase");
  }
});
