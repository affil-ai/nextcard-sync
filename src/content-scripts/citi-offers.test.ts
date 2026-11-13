import { beforeEach, describe, expect, it, vi } from "vitest";

let listener: (message: Record<string, unknown>, sender: unknown, reply: (value: unknown) => void) => boolean | undefined;
const request = vi.fn();
const sendMessage = vi.fn((message: Record<string, unknown>, callback?: (value: unknown) => void) => {
  if (callback) callback(request(message));
  return Promise.resolve({ ok: true });
});
const accounts = { creditCardAccount: { accountDetails: [
  { accountId: "one", accountStatus: "ACTIVE", productName: "Card", displayAccountNumber: "1234" },
] } };
const response = (data: unknown, status = 200) => ({ status, data });

beforeEach(async () => {
  vi.resetModules(); request.mockReset(); sendMessage.mockClear();
  vi.stubGlobal("chrome", { runtime: { lastError: null, sendMessage, onMessage: {
    addListener: (callback: typeof listener) => { listener = callback; },
  } } });
  await import("./citi-offers");
});

function discover(): Promise<unknown> {
  return new Promise(resolve => listener({ type: "CITI_OFFERS_DISCOVER", runId: "run" }, {}, resolve));
}

describe("Citi discovery and activation reads", () => {
  it("accepts explicit empty offer lists", async () => {
    request.mockReturnValueOnce(response(accounts)).mockReturnValueOnce(response({ merchantOffers: [] }));
    expect(await discover()).toMatchObject({ offerCounts: { one: 0 }, offersByCard: { one: [] } });
  });

  it.each([0, 401, 403, 500])("does not turn HTTP %s into zero offers", async status => {
    request.mockReturnValueOnce(response(accounts)).mockReturnValueOnce(response(null, status));
    expect(await discover()).toMatchObject({ cards: [], error: status === 401 || status === 403 ? "session_expired" : "request_failed" });
    expect(sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "CITI_OFFERS_DETECTED" }));
  });

  it.each([null, {}, { merchantOffers: null }, { merchantOffers: [{}] }, { merchantOffers: [{ offers: [null] }] }])(
    "reports malformed offer payload %j", async payload => {
      request.mockReturnValueOnce(response(accounts)).mockReturnValueOnce(response(payload));
      expect(await discover()).toMatchObject({ cards: [], error: "invalid_response" });
    },
  );

  it.each([null, {}, { creditCardAccount: { accountDetails: [null] } }])("reports malformed account payload %j", async payload => {
    request.mockReturnValueOnce(response(payload));
    expect(await discover()).toMatchObject({ cards: [], error: "invalid_response" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports an expired account session rather than no cards", async () => {
    request.mockReturnValueOnce(response(null, 401));
    expect(await discover()).toMatchObject({ error: "session_expired" });
  });

  it("ends a hung background request with a failure", async () => {
    vi.useFakeTimers();
    try {
      sendMessage.mockImplementationOnce(() => Promise.resolve({ ok: true }));
      const result = discover();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ cards: [], error: "request_failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves genuine empty accounts", async () => {
    request.mockReturnValueOnce(response({ creditCardAccount: { accountDetails: [] } }));
    expect(await discover()).toMatchObject({ cards: [], error: "no_cards" });
  });

  it("fails activation when its fresh offer read fails instead of completing with zero offers", async () => {
    request.mockReturnValueOnce(response(null, 401));
    listener({ type: "CITI_OFFERS_RUN", runId: "run", selectedCardKeys: ["one"], cards: [{ id: "one", name: "Card" }] }, {}, () => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "CITI_OFFERS_COMPLETE", error: "Sign in to Citi again, then check offers.",
    })));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("lists valid offers, deduplicates categories, and activates only selected offers", async () => {
    const offer = { offerId: "chosen", merchantName: "Merchant", enrollmentStatus: "AVAILABLE" };
    const listing = { merchantOffers: [{ offers: [offer, { ...offer, offerId: "other" }] }, { offers: [offer] }] };
    request.mockReturnValueOnce(response(accounts)).mockReturnValueOnce(response(listing));
    expect(await discover()).toMatchObject({ offerCounts: { one: 2 } });
    request.mockReturnValueOnce(response(listing)).mockReturnValueOnce(response({ enrollmentId: "enrolled" }));
    listener({ type: "CITI_OFFERS_RUN", runId: "run", selectedCardKeys: ["one"], cards: [{ id: "one", name: "Card" }], selectedOfferIdsByCard: { one: ["chosen"] } }, {}, () => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "CITI_OFFERS_COMPLETE", added: 1, failed: 0 })));
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[3][0]).toMatchObject({ body: JSON.stringify({ offerId: "chosen", accountId: "one" }) });
  });
});
