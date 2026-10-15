import { z } from "zod";
import { getAuth, getAuthGeneration } from "../lib/auth";
import {
  getHouseholdScopedStorageKey,
  parseHouseholdOperationScope,
  getCurrentHouseholdOperationScope,
  householdOperationScopesMatch,
  isLegacyHouseholdOperationMode,
  type HouseholdOperationScope,
} from "../lib/household-context";
import { getStoredExtensionProfile } from "../lib/extension-profile";
import {
  reserveOfferActivations,
  recordOfferActivations,
} from "../lib/offer-activation-usage";
import { pullOfferUrlCache } from "../lib/sync-offers-to-nextcard";
import {
  bofaOfferSchema,
  bofaPortalStateSchema,
  bofaPortalBatchSchema,
  type BofaPortalBatch,
  type BofaPortalState,
  collectBofaOfferIds,
  normalizeBofaOffer,
  type PortalOffer,
} from "../providers/bofa-offers";
import { bofaPortalRequest } from "./bofa-portal-api";

const STATE_KEY = "bofa_portal_operation";
const PENDING_KEY = "bofa_portal_pending";
type Operation = {
  state: BofaPortalState;
  scope: HouseholdOperationScope | null;
  portalId: string;
  tabId: number;
  generation: number;
  authFingerprint: string;
  cancelled: boolean;
  readConcurrency: number;
  readPausedUntil: number;
};

class BofaRequestError extends Error {}

export function registerBofaOffers(options: { isOtherBusy?: () => Promise<boolean>; canWriteOffers?: () => Promise<boolean> } = {}) {
  let operation: Operation | null = null;
  let starting = false;
  let activating = false;
  let openingRevision = 0;
  let queue = Promise.resolve();

  async function authFingerprint() {
    const auth = await getAuth();
    if (!auth) return null;
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(auth.token),
    );
    return Array.from(new Uint8Array(bytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  async function scopeCurrent(
    scope: HouseholdOperationScope | null,
    generation: number,
  ) {
    if (generation !== getAuthGeneration() || !(await getAuth())) return false;
    const current = await getCurrentHouseholdOperationScope();
    return scope === null
      ? current === null && (await isLegacyHouseholdOperationMode())
      : current !== null && householdOperationScopesMatch(scope, current);
  }
  async function requireCurrent(op: Operation) {
    if (
      op.cancelled ||
      operation !== op ||
      !(await scopeCurrent(op.scope, op.generation))
    )
      throw new Error(
        "The operation stopped or the selected account changed. Check again.",
      );
  }
  async function persist(op: Operation) {
    if (!(await scopeCurrent(op.scope, op.generation)) || operation !== op) return;
    await chrome.storage.local.set({
      [STATE_KEY]: {
        state: op.state,
        scope: op.scope,
        authFingerprint: op.authFingerprint,
      },
    });
  }
  async function request(
    op: Operation,
    kind: "search" | "details" | "activate",
    input: number | string,
  ) {
    for (let attempt = 0; attempt < 6; attempt++) {
      await requireCurrent(op);
      if (kind !== "activate") {
        while (op.readPausedUntil > Date.now()) {
          await new Promise<void>(resolve => setTimeout(resolve, op.readPausedUntil - Date.now()));
          await requireCurrent(op);
        }
        if (op.state.retryAt !== undefined) {
          delete op.state.retryAt;
          await persist(op);
          await requireCurrent(op);
        }
      }
      const tab = await chrome.tabs.get(op.tabId).catch(() => null);
      if (
        !tab?.url ||
        new URL(tab.url).origin !== "https://deals.merchant-rewards.com"
      )
        throw new BofaRequestError(
          "Your BofA portal tab closed or changed. Check again.",
        );
      const results = await chrome.scripting.executeScript({
        target: { tabId: op.tabId },
        world: "MAIN",
        func: bofaPortalRequest,
        args: [kind, op.portalId, input],
      });
      if (kind !== "activate") await requireCurrent(op);
      const failure = z
        .object({ error: z.string() })
        .safeParse(results[0]?.result);
      if (failure.success) throw new BofaRequestError(failure.data.error);
      const result = z
        .object({
          portalId: z.string(), status: z.number(), data: z.unknown(),
          retryAfterMs: z.number().finite().nonnegative().optional(),
        })
        .parse(results[0]?.result);
      if (result.portalId !== op.portalId)
        throw new BofaRequestError("Your BofA portal account changed. Check offers again.");
      if (kind !== "activate" && [408, 429, 500, 502, 503, 504].includes(result.status)) {
        op.readConcurrency = Math.max(1, Math.floor(op.readConcurrency / 2));
        if (attempt < 5 && (result.retryAfterMs ?? 0) <= 60000) {
          op.readPausedUntil = Math.max(
            op.readPausedUntil,
            Date.now() + Math.max(result.retryAfterMs ?? 0, 2000 * 2 ** attempt),
          );
          op.state.retryAt = op.readPausedUntil;
          await persist(op);
          continue;
        }
        throw new BofaRequestError(result.status === 429
          ? "BofA is still limiting requests. Your saved offers are available. Try again later."
          : "BofA is temporarily unavailable. Your saved offers are available. Try again later.");
      }
      if (result.status !== 200)
        throw new BofaRequestError(
          `BofA could not return offers (${result.status}). Check again.`,
        );
      return result.data;
    }
    throw new BofaRequestError("BofA could not return this request.");
  }
  async function detail(op: Operation, id: string) {
    const response = z
      .object({ offer: bofaOfferSchema })
      .parse(await request(op, "details", id));
    if (response.offer.offer_id !== id)
      throw new Error("BofA returned a different offer. Check again.");
    return normalizeBofaOffer(response.offer);
  }
  async function sendBatch(op: Operation, batch: BofaPortalBatch) {
    await requireCurrent(op);
    const auth = await getAuth();
    if (!auth) throw new Error("Sign in to nextcard again.");
    const response = await fetch(
      `${__CONVEX_SITE_URL__}/extension/${op.scope ? "v2/" : ""}portal-offers-sync`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.token}`,
          ...(op.scope
            ? {
                "X-Nextcard-Protocol-Version": "2",
                "X-Nextcard-Extension-Version":
                  chrome.runtime.getManifest().version,
              }
            : {}),
        },
        body: JSON.stringify({
          batch,
          ...(op.scope
            ? {
                memberId: op.scope.memberId,
                contextRevision: op.scope.contextRevision,
                memberLifecycleVersion: op.scope.memberLifecycleVersion,
              }
            : {}),
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    await requireCurrent(op);
    if (!response.ok) {
      const body: unknown = await response.json();
      const code =
        body &&
        typeof body === "object" &&
        "code" in body &&
        typeof body.code === "string"
          ? body.code
          : "save_failed";
      if (
        response.status === 401 ||
        response.status === 409 ||
        response.status === 400
      )
        throw new Error(code);
      throw new Error("save_failed");
    }
    const result = z
      .object({ ok: z.literal(true), saved: z.number() })
      .parse(await response.json());
    if (result.saved !== batch.offers.length) throw new Error("save_failed");
  }
  async function save(op: Operation, offers: PortalOffer[]) {
    if (!offers.length) return;
    // Keep detailed terms below the Convex mutation argument size limit.
    if (new TextEncoder().encode(JSON.stringify(offers)).byteLength > 500000) {
      if (offers.length === 1)
        throw new Error(
          "This offer has too much content to save. Review it on BofA.",
        );
      const middle = Math.ceil(offers.length / 2);
      await save(op, offers.slice(0, middle));
      await save(op, offers.slice(middle));
      return;
    }
    const batch: BofaPortalBatch = {
      issuerPortalId: op.portalId,
      capturedAt: new Date().toISOString(),
      offers,
    };
    const task = queue.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await sendBatch(op, batch);
          return;
        } catch (error) {
          await requireCurrent(op);
          if (
            error instanceof Error &&
            [
              "context_stale",
              "member_unavailable",
              "member_gone",
              "member_offer_writes_disabled",
              "invalid_request",
            ].includes(error.message)
          )
            throw error;
          if (attempt < 2) await new Promise<void>((r) => setTimeout(r, 2000));
        }
      }
      await requireCurrent(op);
      const stored = await chrome.storage.local.get(
        getHouseholdScopedStorageKey(PENDING_KEY, op.scope),
      );
      const pending = z
        .array(bofaPortalBatchSchema)
        .catch([])
        .parse(stored[getHouseholdScopedStorageKey(PENDING_KEY, op.scope)]);
      // Only this selected account's pending queue is retained. Auth clearing removes it.
      await chrome.storage.local.set({
        [getHouseholdScopedStorageKey(PENDING_KEY, op.scope)]: [
          ...pending,
          batch,
        ],
      });
      op.state.saveStatus = "queued_for_retry";
    });
    queue = task.catch(() => {});
    await task;
  }
  async function discover(op: Operation) {
    let pendingSave: Promise<void> | null = null;
    try {
      // Retry only the current portal's account- and household-scoped queue.
      const stored = await chrome.storage.local.get(
        getHouseholdScopedStorageKey(PENDING_KEY, op.scope),
      );
      const pending = z
        .array(bofaPortalBatchSchema)
        .catch([])
        .parse(stored[getHouseholdScopedStorageKey(PENDING_KEY, op.scope)]);
      for (const batch of pending)
        if (batch.issuerPortalId === op.portalId) await sendBatch(op, batch);
      const remaining = pending.filter(
        (batch) => batch.issuerPortalId !== op.portalId,
      );
      if (pending.length)
        await chrome.storage.local.set({
          [getHouseholdScopedStorageKey(PENDING_KEY, op.scope)]: remaining,
        });
      const ids = await collectBofaOfferIds(
        (offset) => request(op, "search", offset),
        async (discovered, total) => {
          op.state.discovered = discovered;
          op.state.total = total;
          await persist(op);
        },
      );
      op.state.total = ids.length;
      await persist(op);
      for (let offset = 0; offset < ids.length; offset += 50) {
        const chunk = ids.slice(offset, offset + 50);
        const readOffers = new Map<string, PortalOffer>();
        let next = 0;
        const failures: unknown[] = [];
        // Keep a bounded pool of reads, reducing concurrency after issuer backoff.
        const workers = await Promise.allSettled(Array.from({ length: Math.min(op.readConcurrency, chunk.length) }, async (_, worker) => {
          while (next < chunk.length && !failures.length && worker < op.readConcurrency) {
            const id = chunk[next++];
            try {
              readOffers.set(id, await detail(op, id));
            } catch (error) {
              if (error instanceof BofaRequestError) {
                failures.push(error);
                return;
              }
              op.state.failed++;
            }
            op.state.checked++;
            if (op.state.checked % 10 === 0) await persist(op);
          }
        }));
        await requireCurrent(op);
        const failedWorker = workers.find(result => result.status === "rejected");
        if (failedWorker?.status === "rejected") throw failedWorker.reason;
        if (failures.length) throw failures[0];
        const offers = chunk.flatMap(id => {
          const offer = readOffers.get(id);
          return offer ? [offer] : [];
        });
        // At most one upload overlaps the next read batch. Drain it before
        // starting another upload or reporting completion.
        if (pendingSave) await pendingSave;
        await requireCurrent(op);
        op.state.offers.push(...offers);
        pendingSave = save(op, offers);
        void pendingSave.catch(() => {});
        await persist(op);
      }
      if (pendingSave) await pendingSave;
      await requireCurrent(op);
      op.state.phase = "ready";
      delete op.state.retryAt;
      if (op.state.saveStatus !== "queued_for_retry")
        op.state.saveStatus = "saved";
      if (op.state.failed)
        op.state.error = `${op.state.failed} offer${op.state.failed === 1 ? "" : "s"} could not be read. Your saved offers are still available.`;
      await persist(op);
      await pullOfferUrlCache(op.scope);
    } catch (error) {
      if (pendingSave) await pendingSave.catch(() => {});
      op.state.phase = op.cancelled ? "cancelled" : "failed";
      delete op.state.retryAt;
      op.state.error =
        error instanceof Error ? error.message : "Could not check BofA offers.";
      await persist(op);
    }
  }
  async function start(reconnect = false) {
    if (
      starting ||
      operation?.state.phase === "checking" ||
      operation?.state.phase === "activating"
    )
      throw new Error("A BofA operation is already running.");
    starting = true;
    const revision = ++openingRevision;
    const assertOpening = () => { if (revision !== openingRevision) throw new Error("BofA check cancelled."); };
    try {
      if (await options.isOtherBusy?.()) throw new Error("Finish or stop the current offer check first.");
      if (options.canWriteOffers && !await options.canWriteOffers()) throw new Error("Offers sync is unavailable for this profile.");
      const generation = getAuthGeneration();
      const scope = await getCurrentHouseholdOperationScope();
      if (!(await scopeCurrent(scope, generation)))
        throw new Error("Sign in to nextcard and select a Wallet first.");
      const tabs = await chrome.tabs.query({
        url: "https://deals.merchant-rewards.com/*",
      });
      let tab = reconnect ? undefined : tabs.find((t) => t.active) ?? tabs[0];
      if (tab?.id === undefined) {
        assertOpening();
        // BofA's own View all deals link establishes the separate portal session.
        const dealsUrl =
          "https://secure.bankofamerica.com/myaccounts/brain/redirect.go?request_locale=en-us&target=offers&source=rewardDeals&location=myRewards";
        const bankingTabs = await chrome.tabs.query({
          url: "https://secure.bankofamerica.com/*",
        });
        const bankingTab = bankingTabs.find((t) => t.active) ?? bankingTabs[0];
        assertOpening();
        const opened =
          !reconnect && bankingTab?.id !== undefined
            ? await chrome.tabs.update(bankingTab.id, {
                url: dealsUrl,
                active: true,
              })
            : await chrome.tabs.create({ url: dealsUrl, active: true });
        if (opened?.id !== undefined) {
          let redirectedAfterLogin = false;
          for (let attempt = 0; attempt < 480; attempt++) {
            assertOpening();
            if (!(await scopeCurrent(scope, generation)))
              throw new Error(
                "The selected nextcard account changed. Check again.",
              );
            const current = await chrome.tabs.get(opened.id);
            if (
              current.status === "complete" &&
              current.url?.startsWith("https://deals.merchant-rewards.com/")
            ) {
              tab = current;
              break;
            }
            if (
              !redirectedAfterLogin &&
              attempt % 4 === 0 &&
              current.status === "complete" &&
              current.url?.startsWith("https://secure.bankofamerica.com/")
            ) {
              // Login may return to Accounts rather than retain BofA's deals target.
              // Inspect only the signed-in navigation, never credentials or balances.
              const signedIn = await chrome.scripting.executeScript({
                target: { tabId: opened.id },
                func: () =>
                  Array.from(document.querySelectorAll("a")).some((link) =>
                    /^log\s*out$/i.test(link.textContent?.trim() ?? ""),
                  ),
              }).catch(() => []);
              if (signedIn[0]?.result === true) {
                redirectedAfterLogin = true;
                await chrome.tabs.update(opened.id, {
                  url: dealsUrl,
                  active: true,
                });
              }
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
          }
        }
        if (tab?.id === undefined)
          throw new Error(
            "In BofA, open Rewards & Deals, then Deals and View all deals. Keep that deals portal open and check offers again.",
          );
      }
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: bofaPortalRequest,
        args: ["session", null, null],
      });
      const failure = z
        .object({ error: z.string() })
        .safeParse(result[0]?.result);
      if (failure.success) {
        if (!reconnect && /session.*(?:expired|unavailable)|not signed in/i.test(failure.data.error)) {
          assertOpening();
          starting = false;
          return await start(true);
        }
        throw new BofaRequestError(failure.data.error);
      }
      const session = z
        .object({ portalId: z.string().regex(/^v1:[a-f0-9]{64}$/) })
        .parse(result[0]?.result);
      const fingerprint = await authFingerprint();
      if (!fingerprint || !(await scopeCurrent(scope, generation)))
        throw new Error("The selected nextcard account changed. Check again.");
      // A fresh owned search page lets the issuer resolve its saved or estimated
      // location normally. The MAIN-world listener captures only its read-request
      // coordinates, without asking for GPS or sending them to Nextcard.
      assertOpening();
      const owned = await chrome.tabs.create({
        url: "https://deals.merchant-rewards.com/search",
        active: true,
      });
      if (owned.id === undefined)
        throw new Error("Could not open the BofA deals portal.");
      let locationReady = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        assertOpening();
        if (!(await scopeCurrent(scope, generation)))
          throw new Error("The selected account changed. Check again.");
        let ready: chrome.scripting.InjectionResult<unknown>[] = [];
        try {
          ready = await chrome.scripting.executeScript({
            target: { tabId: owned.id },
            world: "MAIN",
            func: bofaPortalRequest,
            args: ["session", session.portalId, null],
          });
        } catch {
          /* The new issuer tab may still be loading. */
        }
        const context = z
          .object({ portalId: z.string(), hasLocationContext: z.boolean() })
          .safeParse(ready[0]?.result);
        if (
          context.success &&
          context.data.portalId === session.portalId &&
          context.data.hasLocationContext
        ) {
          locationReady = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
      }
      if (!locationReady)
        throw new Error(
          "Choose a location in the BofA search page, then check offers again.",
        );
      assertOpening();
      const op: Operation = {
        authFingerprint: fingerprint,
        scope,
        generation,
        portalId: session.portalId,
        tabId: owned.id,
        cancelled: false,
        readConcurrency: 8,
        readPausedUntil: 0,
        state: {
          runId: crypto.randomUUID(),
          phase: "checking",
          total: 0,
          checked: 0,
          discovered: 0,
          added: 0,
          failed: 0,
          offers: [],
          error: null,
          saveStatus: "saving",
        },
      };
      operation = op;
      await persist(op);
      void discover(op);
      return op.state;
    } finally {
      starting = false;
    }
  }
  async function activate(ids: string[], runId: string) {
    if (activating) throw new Error("A BofA activation is already starting.");
    activating = true;
    try {
      if (await options.isOtherBusy?.()) throw new Error("Finish or stop the current offer check first.");
      if (options.canWriteOffers && !await options.canWriteOffers()) throw new Error("Offers sync is unavailable for this profile.");
      const op = operation;
      if (
        !op ||
        op.state.runId !== runId ||
        (op.state.phase !== "ready" && op.state.phase !== "completed") ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        ids.some(
          (id) =>
            !op.state.offers.some(
              (o) => o.issuerOfferId === id && o.action === "activate",
            ),
        )
      )
        throw new Error("Check offers again before activating.");
      await requireCurrent(op);
      const auth = await getAuth();
      const profile = await getStoredExtensionProfile();
      const activationRunId = crypto.randomUUID();
      const reservation = await reserveOfferActivations(
        auth?.email,
        profile?.accountLevel === "pro",
        activationRunId,
        ids.length,
      );
      if (!reservation.ok || reservation.granted < ids.length) {
        await recordOfferActivations(auth?.email, activationRunId, 0);
        throw new Error(
          "Your monthly activation limit does not cover this selection. Select fewer offers.",
        );
      }
      try {
        await requireCurrent(op);
      } catch (error) {
        await recordOfferActivations(auth?.email, activationRunId, 0);
        throw error;
      }
      op.state.phase = "activating";
      op.state.added = 0;
      op.state.error = null;
      await persist(op);
      void (async () => {
        let issued = 0;
        try {
          for (const id of ids) {
            await requireCurrent(op);
            const before = await detail(op, id);
            if (before.action !== "activate") continue;
            // Once a PUT has been issued, do not automatically repeat it after an uncertain response.
            const response = z
              .object({ ok: z.boolean() })
              .parse(await request(op, "activate", id));
            if (!response.ok) {
              op.state.failed++;
              continue;
            }
            issued++;
            const verified = await detail(op, id);
            if (verified.action !== "activated")
              throw new Error(
                "BofA accepted activation but has not confirmed it. Check again before retrying.",
              );
            op.state.added++;
            op.state.offers = op.state.offers.map((o) =>
              o.issuerOfferId === id ? verified : o,
            );
            await save(op, [verified]);
            await persist(op);
          }
          op.state.phase = "completed";
          if (op.state.saveStatus !== "queued_for_retry")
            op.state.saveStatus = "saved";
          await pullOfferUrlCache(op.scope);
        } catch (error) {
          op.state.phase = op.cancelled ? "cancelled" : "failed";
          op.state.error =
            error instanceof Error
              ? error.message
              : "Activation could not be verified.";
        } finally {
          await recordOfferActivations(auth?.email, activationRunId, issued);
          await persist(op);
        }
      })();
      return op.state;
    } finally { activating = false; }
  }
  chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    const envelope = z
      .object({
        type: z.string(),
        ids: z.array(z.string()).optional(),
        runId: z.string().optional(),
      })
      .safeParse(message);
    if (
      !envelope.success ||
      !envelope.data.type.startsWith("BOFA_PORTAL_") ||
      sender.id !== chrome.runtime.id ||
      sender.tab
    )
      return;
    void (async () => {
      try {
        const { type, ids, runId } = envelope.data;
        if (type === "BOFA_PORTAL_CHECK" || type === "BOFA_PORTAL_SIGN_IN")
          return respond({
            ok: true,
            state: await start(type === "BOFA_PORTAL_SIGN_IN"),
          });
        if (type === "BOFA_PORTAL_ACTIVATE")
          return respond({
            ok: true,
            state: await activate(ids ?? [], runId ?? ""),
          });
        if (type === "BOFA_PORTAL_FINISH" || type === "BOFA_PORTAL_REVIEW") {
          if (!operation || operation.state.runId !== runId ||
              (operation.state.phase !== "ready" && operation.state.phase !== "completed")) {
            throw new Error("Check offers again before continuing this review.");
          }
          await requireCurrent(operation);
          operation.state.reviewFinished = type === "BOFA_PORTAL_FINISH";
          if (type === "BOFA_PORTAL_REVIEW") operation.state.phase = "ready";
          await persist(operation);
        }
        if (type === "BOFA_PORTAL_CANCEL") openingRevision++;
        if (type === "BOFA_PORTAL_CANCEL" && operation) {
          operation.cancelled = true;
          operation.state.phase = "cancelled";
          delete operation.state.retryAt;
          await persist(operation);
        }
        if (operation) {
          if (!(await scopeCurrent(operation.scope, operation.generation)))
            return respond({ ok: true, state: null });
          return respond({ ok: true, state: operation.state });
        }
        // A worker restart loses the bound issuer session. Preserve the result,
        // but require a fresh check before issuing any more activation writes.
        const stored = await chrome.storage.local.get(STATE_KEY);
        const result = z
          .object({
            state: bofaPortalStateSchema,
            scope: z.unknown(),
            authFingerprint: z.string(),
          })
          .safeParse(stored[STATE_KEY]);
        if (!result.success) return respond({ ok: true, state: null });
        const storedScope =
          result.data.scope === null
            ? null
            : parseHouseholdOperationScope(result.data.scope);
        if (
          storedScope === undefined ||
          !(await scopeCurrent(storedScope, getAuthGeneration())) ||
          result.data.authFingerprint !== (await authFingerprint())
        )
          return respond({ ok: true, state: null });
        const state = result.data.state;
        if (
          state.phase === "checking" ||
          state.phase === "activating" ||
          (state.phase === "ready" && !state.reviewFinished)
        ) {
          state.phase = "failed";
          state.error =
            "The extension restarted. Check offers again to continue.";
        }
        respond({ ok: true, state });
      } catch (error) {
        respond({
          ok: false,
          error:
            error instanceof Error ? error.message : "BofA operation failed.",
        });
      }
    })();
    return true;
  });
  return { isBusy: () => starting || activating || operation?.state.phase === "checking" || operation?.state.phase === "activating" };
}
