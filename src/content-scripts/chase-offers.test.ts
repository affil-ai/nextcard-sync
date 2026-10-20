// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://secure.chase.com"}
import { beforeEach, describe, expect, it, vi } from "vitest";

let listener: (message: Record<string, unknown>, sender: unknown, reply: (value: unknown) => void) => boolean | undefined;
const fetchMock = vi.fn();
const sendMessage = vi.fn(async (_value: unknown) => ({ ok: true }));
const accounts = { accounts: [{ id: "one", groupType: "CARD", productDescription: "Card", mask: "1234" }] };
const offers = (activated = false) => ({ customerOffers: [{ offers: [
  { offerIdentifier: "chosen", MerchantName: "Selected merchant", offerStatusName: activated ? "ACTIVATED" : "NEW" },
  { offerIdentifier: "other", MerchantName: "Unselected merchant", offerStatusName: "NEW" },
] }] });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

beforeEach(async () => {
  vi.resetModules(); fetchMock.mockReset(); sendMessage.mockClear();
  document.cookie = "PC_1_0=ECI=test; path=/";
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", { runtime: { sendMessage, onMessage: {
    addListener: (callback: typeof listener) => { listener = callback; },
  } } });
  await import("./chase-offers");
});

function discover(): Promise<unknown> {
  return new Promise((resolve) => listener({ type: "CHASE_OFFERS_DISCOVER", runId: "run" }, {}, resolve));
}

describe("Chase discovery and activation boundary", () => {
  it("reports a valid empty listing as zero, but not an HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response({ customerOffers: [{ offers: [] }] }));
    expect(await discover()).toMatchObject({ offerCounts: { one: 0 }, offersByCard: { one: [] } });
    fetchMock.mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response({}, 500));
    expect(await discover()).toMatchObject({ error: "request_failed", cards: [] });
  });
  it("reports an expired session and malformed responses instead of zero offers", async () => {
    fetchMock.mockResolvedValueOnce(response(accounts));
    document.cookie = "PC_1_0=; Max-Age=0; path=/";
    expect(await discover()).toMatchObject({ error: "session_expired" });
    document.cookie = "PC_1_0=ECI=test; path=/";
    fetchMock.mockResolvedValueOnce(response(accounts)).mockResolvedValueOnce(response({ unexpected: [] }));
    expect(await discover()).toMatchObject({ error: "invalid_response" });
  });
  it("submits only the chosen offer and confirms issuer status before reporting it saved", async () => {
    fetchMock.mockResolvedValueOnce(response(offers())).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response(offers(true)));
    listener({ type: "CHASE_OFFERS_RUN", runId: "run", selectedCardKeys: ["one"], allCardIds: ["one"],
      cards: [{ id: "one", name: "Card", lastDigits: "1234" }], maxOffers: 1,
      selectedOfferIdsByCard: { one: ["chosen"] } }, {}, () => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "CHASE_OFFERS_COMPLETE", added: 1, unverified: 0 })));
    const enrollmentUrls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("reco.chase.com"));
    expect(enrollmentUrls).toHaveLength(1); expect(enrollmentUrls[0]).toContain("offer-identifier=chosen");
    expect(enrollmentUrls[0]).not.toContain("offer-identifier=other");
  });
  it("advances submission progress before verifying actual activations", async () => {
    fetchMock.mockResolvedValueOnce(response(offers()))
      .mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(offers(true)));
    listener({ type: "CHASE_OFFERS_RUN", runId: "run", selectedCardKeys: ["one"], allCardIds: ["one"],
      cards: [{ id: "one", name: "Card" }], selectedOfferIdsByCard: { one: ["chosen", "other"] } }, {}, () => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "CHASE_OFFERS_COMPLETE", added: 1, failed: 1 })));
    const progress = sendMessage.mock.calls.map(([message]) => message).filter((message) =>
      typeof message === "object" && message !== null && "processed" in message);
    expect(progress).toEqual([
      expect.objectContaining({ processed: 0, total: 2, added: 0, verifying: false }),
      expect.objectContaining({ processed: 1, total: 2, added: 0, verifying: false }),
      expect.objectContaining({ processed: 2, total: 2, added: 0, verifying: false }),
      expect.objectContaining({ processed: 2, total: 2, added: 0, verifying: true }),
    ]);
  });
  it("does not replace a selected offer that disappeared and does not call issuer activation", async () => {
    fetchMock.mockResolvedValueOnce(response(offers()));
    listener({ type: "CHASE_OFFERS_RUN", runId: "run", selectedCardKeys: ["one"], allCardIds: ["one"],
      cards: [{ id: "one", name: "Card" }], selectedOfferIdsByCard: { one: ["missing"] } }, {}, () => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "CHASE_OFFERS_COMPLETE", added: 0, error: expect.stringContaining("no longer available") })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not claim an accepted request activated the offer when verification fails", async () => {
    fetchMock.mockResolvedValueOnce(response(offers())).mockResolvedValueOnce(response({})).mockResolvedValueOnce(response({}, 500));
    listener({ type: "CHASE_OFFERS_RUN", runId: "run", selectedCardKeys: ["one"], allCardIds: ["one"],
      cards: [{ id: "one", name: "Card" }], selectedOfferIdsByCard: { one: ["chosen"] } }, {}, () => {});
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "CHASE_OFFERS_COMPLETE", added: 0, unverified: 1 })));
  });
});
