import { describe, expect, it, vi } from "vitest";
import { createExternalMessageRouter } from "./message-router";

function setup(setAuth = vi.fn(async () => {})) {
  const options = {
    nextCardOrigin: "https://nextcard.com",
    setAuth,
    resetAuthCache: vi.fn(),
    hydrateFromNextCard: vi.fn(async () => {}),
    pullOfferUrlCache: vi.fn(async () => {}),
  };
  return { options, router: createExternalMessageRouter(options), reply: vi.fn() };
}
const sender = { url: "https://nextcard.com/extension-auth" };
const message = { type: "AUTH_TOKEN", token: "new-token" };

describe("external sign-in", () => {
  it("keeps the channel open and acknowledges only persisted credentials", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { options, router, reply } = setup(vi.fn(() => pending));
    expect(router(message, sender, reply)).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(options.resetAuthCache).toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("reports a persistence failure without success or hydration", async () => {
    const { options, router, reply } = setup(vi.fn(async () => { throw new Error("storage failed"); }));
    router(message, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: false, error: "sign_in_failed" }));
    expect(options.hydrateFromNextCard).not.toHaveBeenCalled();
    expect(options.resetAuthCache).not.toHaveBeenCalled();
  });

  it("does not delay acknowledgement on optional hydration", async () => {
    const { options, router, reply } = setup();
    options.hydrateFromNextCard.mockImplementation(() => new Promise(() => {}));
    router(message, sender, reply);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
  });

  it("rejects credentials from an untrusted origin", () => {
    const { options, router, reply } = setup();
    router(message, { url: "https://example.com" }, reply);
    expect(reply).toHaveBeenCalledWith({ ok: false });
    expect(options.setAuth).not.toHaveBeenCalled();
  });
});
