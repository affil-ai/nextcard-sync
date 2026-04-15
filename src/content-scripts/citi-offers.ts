/**
 * Citi Offers — discover cards and enroll all eligible merchant offers.
 *
 * All Citi API calls go through the service worker's executeScript (MAIN world)
 * because Citi's API requires same-origin context with session cookies.
 * Auth headers are built from Citi cookies read via document.cookie in MAIN world.
 */

// ── Types ──────────────────────────────────────────────────

interface CitiCard {
  accountId: string;
  name: string;
  lastDigits: string | null;
  displayAccountNumber: string | null;
}

interface CitiOffer {
  offerId: string;
  name: string;
  enrolled: boolean;
}

// ── Helpers ────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(): number {
  return Math.floor(Math.random() * 60) + 20;
}

/** Route a fetch through the service worker's executeScript MAIN world */
function citiFetch(url: string, method: string, body: string | null): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "CITI_OFFERS_FETCH", url, method, body },
      (resp) => {
        if (chrome.runtime.lastError || !resp) resolve({ status: 0, data: null });
        else resolve(resp);
      },
    );
  });
}

// ── Card Discovery ─────────────────────────────────────────

async function discoverCards(): Promise<CitiCard[]> {
  const resp = await citiFetch(
    "https://online.citi.com/gcgapi/prod/public/v1/v2/digital/customers/dashboardTiles/accountDetails",
    "GET",
    null,
  );

  console.log(`[NextCard Citi Offers] Card API response: status=${resp.status}`, resp.data ? Object.keys(resp.data as Record<string, unknown>) : "no data");
  if (resp.status !== 200 || !resp.data) return [];

  const data = resp.data as Record<string, unknown>;
  const creditCard = data.creditCardAccount as Record<string, unknown> | undefined;
  const accounts = (creditCard?.accountDetails ?? []) as Record<string, unknown>[];

  console.log(`[NextCard Citi Offers] Found ${accounts.length} accounts`);
  if (accounts.length > 0) {
    console.log(`[NextCard Citi Offers] Sample account:`, JSON.stringify(accounts[0]).substring(0, 300));
  }

  return accounts
    .filter((a) => {
      // Log why cards are filtered out
      console.log(`[NextCard Citi Offers] Card: ${a.productName ?? a.accountName}, status=${a.accountStatus}, personal=${a.personalAccount}`);
      return a.accountStatus === "ACTIVE";
    })
    .map((a) => ({
      accountId: (a.accountId ?? "") as string,
      name: (a.productName ?? a.accountName ?? "Unknown Card") as string,
      lastDigits: (a.displayAccountNumber ?? null) as string | null,
      displayAccountNumber: (a.displayAccountNumber ?? null) as string | null,
    }));
}

// ── Offer Listing ──────────────────────────────────────────

async function listOffers(accountId: string): Promise<CitiOffer[]> {
  const resp = await citiFetch(
    "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/merchantOffers/retrieve",
    "POST",
    JSON.stringify({ accountId }),
  );

  if (resp.status !== 200 || !resp.data) return [];

  const data = resp.data as Record<string, unknown>;
  const merchantOffers = (data.merchantOffers ?? []) as Record<string, unknown>[];

  // Flatten offers from all categories, deduplicate by offerId
  const seen = new Set<string>();
  const offers: CitiOffer[] = [];

  for (const group of merchantOffers) {
    const groupOffers = (group.offers ?? []) as Record<string, unknown>[];
    for (const o of groupOffers) {
      const offerId = (o.offerId ?? "") as string;
      if (!offerId || seen.has(offerId)) continue;
      seen.add(offerId);
      offers.push({
        offerId,
        name: (o.merchantName ?? o.offerTitle ?? "Unknown") as string,
        enrolled: (o.enrollmentStatus === "ENROLLED") || (o.enrolled === true),
      });
    }
  }

  return offers;
}

// ── Enrollment ─────────────────────────────────────────────

let cancelled = false;
let useFallbackUrl = false;

async function enrollOffer(offerId: string, accountId: string): Promise<boolean> {
  const url = useFallbackUrl
    ? "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/merchantOffers/enrollment"
    : "https://online.citi.com/gcgapi/prod/public/v1/digital/customers/creditCards/accounts/rewards/specialOffers/enrollMerchantOffer";

  const resp = await citiFetch(url, "POST", JSON.stringify({ offerId, accountId }));

  // 404 on primary → switch to fallback
  if (resp.status === 404 && !useFallbackUrl) {
    useFallbackUrl = true;
    return enrollOffer(offerId, accountId);
  }

  if (resp.status !== 200) return false;

  const data = resp.data as Record<string, unknown> | null;
  return !!((data?.EnrolledOfferInfo as Record<string, unknown>)?.enrollmentId || data?.enrollmentId);
}

// ── Runner ─────────────────────────────────────────────────

function sendProgress(data: Record<string, unknown>) {
  chrome.runtime.sendMessage({ type: "CITI_OFFERS_PROGRESS", ...data }).catch(() => {});
}

async function runEnrollment(accountId: string) {
  cancelled = false;
  useFallbackUrl = false;
  sendProgress({ status: "fetching" });

  const offers = await listOffers(accountId);
  const eligible = offers.filter((o) => !o.enrolled);
  console.log(`[NextCard Citi Offers] ${eligible.length} eligible / ${offers.length} total`);

  if (eligible.length === 0) {
    chrome.runtime.sendMessage({ type: "CITI_OFFERS_COMPLETE", added: 0 }).catch(() => {});
    return;
  }

  // Batch enroll via service worker executeScript
  chrome.runtime.sendMessage({
    type: "CITI_OFFERS_BATCH_ENROLL",
    accountId,
    offerIds: eligible.map((o) => o.offerId),
  });

  // Wait for result
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve();
    }, 300000);

    function listener(msg: Record<string, unknown>) {
      if (msg.type === "CITI_OFFERS_BATCH_PROGRESS") {
        // Don't relay — popup listens for this directly
      }
      if (msg.type === "CITI_OFFERS_BATCH_RESULT") {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        chrome.runtime.sendMessage({ type: "CITI_OFFERS_COMPLETE", added: msg.added, failed: msg.failed }).catch(() => {});
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

// ── Message listener ───────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CITI_OFFERS_DISCOVER") {
    (async () => {
      const cards = await discoverCards();
      sendResponse({
        type: "CITI_OFFERS_READY",
        cards: cards.map((c) => ({ id: c.accountId, name: c.name, lastDigits: c.lastDigits })),
        error: cards.length === 0 ? "no_cards" : undefined,
      });
    })();
    return true;
  }

  if (message.type === "CITI_OFFERS_RUN") {
    runEnrollment(message.accountId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "CITI_OFFERS_STOP") {
    cancelled = true;
    sendResponse({ ok: true });
    return true;
  }
});

console.log("[NextCard Citi Offers] Content script loaded");
