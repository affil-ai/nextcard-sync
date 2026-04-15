/**
 * Amex Offers — discover cards and enroll all eligible merchant offers.
 *
 * Card discovery: parses the dashboard HTML for the Transit-encoded productsList.
 * Offer listing: uses ReadOffersHubPresentation.web.v1 via executeScript (MAIN world).
 * Enrollment: batched via executeScript in MAIN world (chunks of 10).
 *
 * All API calls run in MAIN world via the service worker's chrome.scripting.executeScript
 * to avoid CORS issues (same-site origin, session cookies included).
 */

// ── Types ──────────────────────────────────────────────────

interface AmexCard {
  id: string;
  name: string;
  lastDigits: string | null;
  accountKey: string | null;
}

interface AmexOffer {
  offerId: string;
  name: string;
  status: string;
}

// ── Helpers ────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Route an API call through the service worker's executeScript (MAIN world) */
function amexApiFetch(url: string, options: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "AMEX_OFFERS_FETCH", url, method: options.method, headers: options.headers, body: options.body },
      (resp) => {
        if (chrome.runtime.lastError || !resp) resolve({ status: 0, data: null });
        else resolve(resp);
      },
    );
  });
}

// ── Card Discovery ─────────────────────────────────────────

async function discoverCards(): Promise<AmexCard[]> {
  try {
    const resp = await fetch("https://global.americanexpress.com/dashboard", {
      credentials: "include",
      headers: { accept: "text/html" },
    });
    if (!resp.ok || resp.url.includes("/login")) return [];

    const html = await resp.text();
    const startToken = "window.__INITIAL_STATE__ = ";
    const startIdx = html.indexOf(startToken);
    if (startIdx === -1) return [];

    let raw = html.substring(startIdx + startToken.length);
    const endIdx = raw.indexOf(";\n");
    if (endIdx === -1) return [];
    raw = raw.substring(0, endIdx);

    let decoded: string;
    try { decoded = JSON.parse(raw); } catch { decoded = raw; }

    const plIdx = decoded.indexOf("productsList");
    if (plIdx === -1) return [];

    const chunk = decoded.substring(plIdx, plIdx + 50000);
    const cards: AmexCard[] = [];
    const tokenPattern = /"([A-Z0-9]{10,20})",\["\^ "/g;
    let match;

    while ((match = tokenPattern.exec(chunk)) !== null) {
      const accountToken = match[1];
      if (cards.some((c) => c.id === accountToken)) continue;

      const section = chunk.substring(match.index, match.index + 3000);

      const descMatch = section.match(/"description","([^"]+)"/);
      const name = descMatch ? descMatch[1] : `Card ····${accountToken.slice(-4)}`;

      const statusMatch = section.match(/"account_status",\["([^"]+)"/);
      if (statusMatch && statusMatch[1] === "Canceled") continue;

      const digitsMatch = section.match(/"display_account_number","(\d+)"/);
      const lastDigits = digitsMatch ? digitsMatch[1] : null;

      let accountKey: string | null = null;
      const keyMatch = decoded.match(new RegExp(`"accountToken","${accountToken}","accountKey","([^"]+)"`));
      if (keyMatch) accountKey = keyMatch[1];

      cards.push({ id: accountToken, name, lastDigits, accountKey });
    }

    console.log(`[NextCard Amex Offers] Found ${cards.length} cards`);
    return cards;
  } catch (e) {
    console.error("[NextCard Amex Offers] discoverCards error:", e);
    return [];
  }
}

// ── Offer Listing ──────────────────────────────────────────

async function listOffers(cardId: string): Promise<AmexOffer[] | null> {
  try {
    const resp = await amexApiFetch("https://functions.americanexpress.com/ReadOffersHubPresentation.web.v1", {
      method: "POST",
      headers: { accept: "application/json", "ce-source": "WEB", "content-type": "application/json" },
      body: JSON.stringify({
        accountNumberProxy: cardId,
        locale: "en-US",
        offerPage: "page1",
        requestType: "OFFERSHUB_LANDING",
      }),
    });

    if (resp.status !== 200 || !resp.data) return null;

    const data = resp.data as Record<string, unknown>;
    const recList = ((data.recommendedOffers as Record<string, Record<string, unknown[]>>)?.offersList?.page1) ?? [];
    const addedList = ((data.addedToCard as Record<string, Record<string, unknown[]>>)?.offersList?.page1) ?? [];
    const all = [...recList, ...addedList] as Record<string, unknown>[];

    if (all.length === 0) return null;

    return all
      .filter((o) => o.offerType === "MERCHANT")
      .map((o) => ({
        offerId: (o.offerId ?? o.id ?? "") as string,
        name: (o.title ?? o.merchantName ?? "Unknown") as string,
        status: ((o.enrollmentDetails as Record<string, unknown>)?.status ?? "NOT_ENROLLED") as string,
      }));
  } catch (e) {
    console.error("[NextCard Amex Offers] listOffers error:", e);
    return null;
  }
}

// ── Enrollment ─────────────────────────────────────────────

let cancelled = false;

function sendProgress(data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type: "AMEX_OFFERS_PROGRESS", ...data }).catch(() => {});
}

async function runEnrollment(cardId: string) {
  cancelled = false;

  let totalAdded = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let round = 0;
  const MAX_ROUNDS = 5;

  while (round < MAX_ROUNDS && !cancelled) {
    round++;
    sendProgress({ status: "fetching", round, added: totalAdded });

    const offers = await listOffers(cardId);
    if (!offers || offers.length === 0) break;

    const eligible = offers.filter((o) => o.status !== "ENROLLED" && o.status !== "ADDED");
    console.log(`[NextCard Amex Offers] Round ${round}: ${eligible.length} eligible / ${offers.length} total`);
    if (eligible.length === 0) break;

    sendProgress({ status: "enrolling", round, added: totalAdded, total: eligible.length });

    const offerIds = eligible.map((o) => o.offerId);
    const prevAdded = totalAdded;

    // Batch enroll via service worker executeScript (chunks of 10)
    chrome.runtime.sendMessage({ type: "AMEX_OFFERS_BATCH_ENROLL", cardId, offerIds, locale: "en-US" });

    const batchResult = await new Promise<{ added: number; skipped: number; failed: number }>((resolve) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ added: 0, skipped: 0, failed: offerIds.length });
      }, 300000);

      function listener(msg: Record<string, unknown>) {
        if (msg.type === "AMEX_OFFERS_BATCH_PROGRESS") {
          sendProgress({ added: prevAdded + ((msg.added as number) ?? 0), round, total: eligible.length });
        }
        if (msg.type === "AMEX_OFFERS_BATCH_RESULT") {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(msg as unknown as { added: number; skipped: number; failed: number });
        }
      }
      chrome.runtime.onMessage.addListener(listener);
    });

    totalAdded += batchResult.added;
    totalSkipped += batchResult.skipped;
    totalFailed += batchResult.failed;

    console.log(`[NextCard Amex Offers] Round ${round}: ${batchResult.added} added`);

    if (batchResult.added === 0) break;

    if (round < MAX_ROUNDS && !cancelled) {
      sendProgress({ status: "checking_new", round, added: totalAdded });
      await delay(2000);
    }
  }

  chrome.runtime.sendMessage({
    type: "AMEX_OFFERS_COMPLETE",
    added: totalAdded,
    skipped: totalSkipped,
    failed: totalFailed,
    rounds: round,
  }).catch(() => {});
}

// ── Message listener ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "AMEX_OFFERS_DISCOVER") {
    (async () => {
      const cards = await discoverCards();
      sendResponse({
        type: "AMEX_OFFERS_READY",
        cards: cards.map((c) => ({ id: c.id, name: c.name, lastDigits: c.lastDigits, accountKey: c.accountKey })),
        offerCount: -1,
        error: cards.length === 0 ? "no_cards" : undefined,
      });
    })();
    return true;
  }

  if (message.type === "AMEX_OFFERS_RUN") {
    runEnrollment(message.cardId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "AMEX_OFFERS_STOP") {
    cancelled = true;
    sendResponse({ ok: true });
    return true;
  }
});

console.log("[NextCard Amex Offers] Content script loaded");
