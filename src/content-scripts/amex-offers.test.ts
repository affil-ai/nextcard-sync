import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Message = Record<string, unknown>;
let receive:
  | ((
      message: Message,
      sender: unknown,
      reply: (value: unknown) => void,
    ) => unknown)
  | undefined;

beforeEach(() => {
  receive = undefined;
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    count?: number;
    timeoutVerification?: boolean;
    alreadyActive?: boolean;
    activatedDuringRequest?: boolean;
    stopDuringVerification?: boolean;
    missingOffer?: boolean;
  } = {},
) {
  const ids = Array.from(
    { length: options.count ?? 14 },
    (_, index) => `offer-${index}`,
  );
  const enrolled = new Set(options.alreadyActive ? [ids[0]] : []);
  const messages: Message[] = [];
  const attempted: string[] = [];
  let stopped = false;
  const sendMessage = vi.fn(
    (message: Message, reply?: (value: unknown) => void) => {
      messages.push(message);
      if (message.type === "AMEX_OFFERS_FETCH") {
        if (String(message.url).includes("ReadOffersHubPresentation")) {
          const body: unknown = JSON.parse(String(message.body));
          if (
            !body ||
            typeof body !== "object" ||
            !("offerPage" in body) ||
            typeof body.offerPage !== "string"
          )
            throw new Error("Missing page");
          const page = body.offerPage;
          const offers =
            page === "page1"
              ? (options.missingOffer ? ids.slice(1) : ids).map((id) => ({
                  offerId: id,
                  title: "Example merchant",
                  offerType: "MERCHANT",
                  enrollmentDetails: {
                    status: enrolled.has(id) ? "ENROLLED" : "NOT_ENROLLED",
                  },
                }))
              : [];
          reply?.({
            status: 200,
            data: {
              recommendedOffers: {
                offersList: {
                  [page]: offers.filter(
                    (offer) => offer.enrollmentDetails.status !== "ENROLLED",
                  ),
                },
              },
              addedToCard: {
                offersList: {
                  [page]: offers.filter(
                    (offer) => offer.enrollmentDetails.status === "ENROLLED",
                  ),
                },
              },
            },
          });
        } else {
          if (options.stopDuringVerification && !stopped) {
            stopped = true;
            receive?.({ type: "AMEX_OFFERS_STOP", runId: "run" }, {}, () => {});
          }
          if (!options.timeoutVerification)
            reply?.({
              status: 200,
              data: {
                offers: ids.map((id) => ({
                  id,
                  name: "Example merchant",
                  type: "MERCHANT",
                  status: enrolled.has(id) ? "ENROLLED" : "ELIGIBLE",
                })),
              },
            });
        }
      } else if (message.type === "AMEX_OFFERS_ENROLL_ONE") {
        if (typeof message.offerId !== "string")
          throw new Error("Missing offer ID");
        attempted.push(message.offerId);
        if (options.timeoutVerification)
          reply?.({
            result: "unknown",
            status: 0,
            error: "Network request failed",
          });
        else {
          enrolled.add(message.offerId);
          reply?.(
            options.activatedDuringRequest
              ? {
                  result: "failed",
                  status: 200,
                  explanationCode: "PZN4107",
                  failureReason: "already_enrolled_elsewhere",
                }
              : { result: "added", status: 200 },
          );
        }
      }
      return Promise.resolve(
        message.type === "AMEX_OFFERS_DETECTED"
          ? { ok: true, saveStatus: "saved" }
          : undefined,
      );
    },
  );
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: undefined,
      sendMessage,
      onMessage: {
        addListener: (listener: NonNullable<typeof receive>) => {
          receive = listener;
        },
      },
    },
  });
  await import("./amex-offers");
  return {
    attempted,
    messages,
    async run(maxOffers?: number) {
      const started = Date.now();
      receive?.(
        {
          type: "AMEX_OFFERS_RUN",
          runId: "run",
          cardId: "card",
          selectedOfferIdsByCard: { card: ids },
          ...(maxOffers === undefined ? {} : { maxOffers }),
        },
        {},
        () => {},
      );
      await vi.runAllTimersAsync();
      const complete = messages.find(
        (message) => message.type === "AMEX_OFFERS_COMPLETE",
      );
      if (!complete) throw new Error("Amex run did not finish");
      return { complete, elapsed: Date.now() - started };
    },
  };
}

it("activates and verifies the selected offers normally", async () => {
  const run = await fixture();
  const { complete } = await run.run();
  expect(complete).toMatchObject({
    added: 14,
    failed: 0,
    unverified: 0,
    cancelled: false,
  });
  expect(run.attempted).toHaveLength(14);
});

it("stops repeated verification outages without trying every remaining offer", async () => {
  const run = await fixture({ timeoutVerification: true });
  const { complete, elapsed } = await run.run();
  expect(complete).toMatchObject({
    added: 0,
    unverified: 3,
    processed: 3,
    total: 14,
  });
  expect(complete.lastError).toMatch(/remaining offers.*not.*attempted/i);
  expect(run.attempted).toHaveLength(3);
  expect(elapsed).toBeLessThan(95_000);
  expect(
    run.messages
      .filter((message) => message.type === "AMEX_OFFERS_PROGRESS")
      .at(-1),
  ).toMatchObject({ processed: 3, unverified: 3, total: 14 });
});

it("saves an offer activated by another app without reactivating or spending its allowance", async () => {
  const run = await fixture({ count: 2, alreadyActive: true });
  const { complete } = await run.run(1);
  expect(complete).toMatchObject({
    added: 2,
    skipped: 1,
    failed: 0,
    processed: 2,
    total: 2,
  });
  expect(run.attempted).toEqual(["offer-1"]);
  expect(complete.enrolledOffers).toHaveLength(1);
  expect(complete.observationSaveStatus).toBe("saved");
  expect(
    run.messages.find((message) => message.type === "AMEX_OFFERS_DETECTED"),
  ).toMatchObject({
    detectedOffers: [
      expect.objectContaining({ issuerOfferId: "offer-0", status: "enrolled" }),
    ],
  });
});

it("does not charge an activation if another app wins the enrollment race", async () => {
  const run = await fixture({ count: 1, activatedDuringRequest: true });
  const { complete } = await run.run();
  expect(complete).toMatchObject({
    added: 1,
    skipped: 1,
    failed: 0,
    enrolledOffers: [],
    observationSaveStatus: "saved",
  });
  expect(
    run.messages.find((message) => message.type === "AMEX_OFFERS_DETECTED"),
  ).toMatchObject({
    detectedOffers: [
      expect.objectContaining({ issuerOfferId: "offer-0", status: "enrolled" }),
    ],
  });
});

it("finishes verification of the submitted offer before stopping", async () => {
  const run = await fixture({ stopDuringVerification: true });
  const { complete } = await run.run();
  expect(complete).toMatchObject({ added: 1, cancelled: true });
  expect(run.attempted).toHaveLength(1);
});

it("does not substitute another offer when a selected offer disappears", async () => {
  const run = await fixture({ missingOffer: true });
  const { complete } = await run.run();
  expect(complete).toMatchObject({ added: 0, total: 14 });
  expect(complete.lastError).toContain("no longer available");
  expect(run.attempted).toHaveLength(0);
});


it.each([true, false])("imports the modern Amex listing without reconciling an unproven snapshot, enrolled offer returned: %s", async (includeEnrolled) => {
  const messages: Message[] = [];
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: undefined,
      onMessage: {
        addListener: (listener: NonNullable<typeof receive>) => { receive = listener; },
      },
      sendMessage: (message: Message, reply?: (value: unknown) => void) => {
        messages.push(message);
        if (message.type === "AMEX_OFFERS_READ_PRODUCTS") {
          reply?.({ products: [{ accountNumberProxy: "card", description: "Example card", display_account_number: "12345" }] });
        }
        if (message.type === "AMEX_OFFERS_FETCH") {
          if (String(message.url).includes("ReadOffersHubPresentation")) {
            reply?.({ status: 500 });
          } else {
            const body: unknown = JSON.parse(String(message.body));
            if (!body || typeof body !== "object" || !("status" in body) || !Array.isArray(body.status)) {
              throw new Error("Missing requested statuses");
            }
            const statuses = body.status;
            reply?.({ status: 200, data: {
              offers: [
                { id: "available", name: "Available merchant", type: "MERCHANT", status: "ELIGIBLE" },
                { id: "already-added", name: "Previously activated merchant", type: "MERCHANT", status: "ENROLLED" },
              ].filter(offer => statuses.includes(offer.status) && (includeEnrolled || offer.status !== "ENROLLED")),
              count: { eligible: 1 },
            } });
          }
        }
        if (message.type === "AMEX_OFFERS_CACHED_TERMS") {
          return Promise.resolve(["available", "already-added"]);
        }
        return Promise.resolve({ ok: true, saveStatus: "saved" });
      },
    },
  });
  await import("./amex-offers");
  const ready = new Promise(resolve => {
    receive?.({ type: "AMEX_OFFERS_DISCOVER", runId: "discovery" }, {}, resolve);
  });
  await expect(ready).resolves.toMatchObject({
    offerCounts: { card: 1 },
    offersByCard: { card: [{ id: "available" }] },
  });
  await vi.runAllTimersAsync();
  const snapshots = messages.filter(message => message.type === "AMEX_OFFERS_DETECTED");
  expect(snapshots[0]).toMatchObject({
    snapshotComplete: false,
    detectedOffers: [
      { issuerOfferId: "available", status: "detected" },
      ...(includeEnrolled ? [{ issuerOfferId: "already-added", status: "enrolled" }] : []),
    ],
  });
  expect(messages.some(message => message.type === "AMEX_OFFERS_ENROLL_ONE")).toBe(false);
});
