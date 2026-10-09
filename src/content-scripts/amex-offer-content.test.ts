import { describe, expect, it, vi } from "vitest";
import { createAmexOfferContentLoader } from "./amex-offer-content";
import type { AmexOffer } from "./amex-offers";

function offer(offerId: string): AmexOffer {
  return {
    offerId, name: "Example", status: "ELIGIBLE", shortDescription: "Spend $50, get $10",
    expirationText: "2026-12-31", category: null, merchantUrl: null,
    merchantLogoUrl: null, redemptionChannel: "online",
  };
}

describe("Amex terms cache", () => {
  it("skips issuer requests for persisted terms even with a fresh loader", async () => {
    const getCachedOfferIds = vi.fn(async () => ["saved"]);
    const readDetails = vi.fn(async (_offer: AmexOffer) => ({ termsText: "Full terms", status: "ENROLLED" }));
    const rows = [offer("saved"), offer("missing")];
    const load = createAmexOfferContentLoader();
    await load(rows, { getCachedOfferIds, readDetails, isActive: () => true });
    expect(readDetails).toHaveBeenCalledTimes(1);
    expect(readDetails.mock.calls[0]?.[0]).toMatchObject({ offerId: "missing" });
    expect(rows[1].termsText).toBe("Full terms");
    expect(rows[1].status).toBe("ELIGIBLE");
    // A second card reuses successfully captured copy before its queued sync finishes.
    const otherCard = offer("missing");
    await load([otherCard], { getCachedOfferIds, readDetails, isActive: () => true });
    expect(otherCard.termsText).toBe("Full terms");
    expect(readDetails).toHaveBeenCalledTimes(1);
    // Across tabs/restarts, the shared server cache is authoritative.
    await createAmexOfferContentLoader()([offer("saved")], { getCachedOfferIds, readDetails, isActive: () => true });
    expect(readDetails).toHaveBeenCalledTimes(1);
  });

  it("retries failed or description-only reads and fetches changed offer versions", async () => {
    const readDetails = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ detailsText: "Description only" })
      .mockResolvedValue({ termsText: "Full terms" });
    const dependencies = { getCachedOfferIds: vi.fn(async () => []), readDetails, isActive: () => true };
    const load = createAmexOfferContentLoader();
    for (let attempt = 0; attempt < 3; attempt++) await load([offer("one")], dependencies);
    expect(readDetails).toHaveBeenCalledTimes(3);
    await load([{ ...offer("one"), expirationText: "2027-01-31" }], dependencies);
    await load([{ ...offer("one"), shortDescription: "Spend $100, get $20" }], dependencies);
    expect(readDetails).toHaveBeenCalledTimes(5);
  });

  it("defers on a cache outage or cancellation, then retries on the next sync", async () => {
    const readDetails = vi.fn(async (_offer: AmexOffer) => ({ termsText: "Full terms" }));
    const getCachedOfferIds = vi.fn<() => Promise<string[] | null>>().mockResolvedValueOnce(null).mockResolvedValue([]);
    const load = createAmexOfferContentLoader();
    await load([offer("one")], { getCachedOfferIds, readDetails, isActive: () => true });
    await load([offer("one")], { getCachedOfferIds, readDetails, isActive: () => false });
    expect(readDetails).not.toHaveBeenCalled();
    await load([offer("one")], { getCachedOfferIds, readDetails, isActive: () => true });
    expect(readDetails).toHaveBeenCalledTimes(1);
  });

  it("batches large card inventories within the shared lookup limit", async () => {
    const getCachedOfferIds = vi.fn(async (rows: AmexOffer[]) => rows.map(row => row.offerId));
    const readDetails = vi.fn();
    await createAmexOfferContentLoader()(Array.from({ length: 201 }, (_, i) => offer(String(i))), {
      getCachedOfferIds, readDetails, isActive: () => true,
    });
    expect(getCachedOfferIds.mock.calls.map(([rows]) => rows.length)).toEqual([100, 100, 1]);
    expect(readDetails).not.toHaveBeenCalled();
  });

  it("bounds issuer concurrency and coalesces identical requests", async () => {
    let active = 0;
    let peak = 0;
    const readDetails = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return { termsText: "Full terms" };
    });
    const rows = [offer("duplicate"), offer("duplicate"), ...Array.from({ length: 6 }, (_, i) => offer(String(i)))];
    await createAmexOfferContentLoader()(rows, { getCachedOfferIds: async () => [], readDetails, isActive: () => true });
    expect(readDetails).toHaveBeenCalledTimes(7);
    expect(peak).toBeLessThanOrEqual(3);
    expect(rows.every(row => row.termsText === "Full terms")).toBe(true);
  });
});
