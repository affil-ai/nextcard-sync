import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { captureBofaLocationContext } from "./bofa-location-context";

describe("BofA issuer location context", () => {
  it("observes only issuer offer reads and passes requests through unchanged", async () => {
    const sent: unknown[] = [];
    class IssuerXHR {
      open(...args: unknown[]) {
        sent.push(args);
      }
      send(body: unknown) {
        sent.push(body);
      }
    }
    const window: {
      fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
      __nextcardBofaLocation?: {
        latitude: number;
        longitude: number;
        sessionHash: string;
      };
    } = {
      fetch: async (input, init) => {
        sent.push([input, init]);
        return new Response("ok");
      },
    };
    runInNewContext(`(${captureBofaLocationContext.toString()})()`, {
      window,
      XMLHttpRequest: IssuerXHR,
      URL,
      URLSearchParams,
      TextEncoder,
      crypto,
      location: {
        href: "https://deals.merchant-rewards.com/search",
        search: "",
      },
      localStorage: { getItem: () => "synthetic-issuer-session" },
    });
    const body = JSON.stringify({
      proximity_target: { latitude: 37, longitude: -122 },
    });
    await window.fetch("https://unrelated.example/api/offers-search", { body });
    await window.fetch("/api/activate-offer/123", { body });
    expect(window.__nextcardBofaLocation).toBeUndefined();
    const xhr = new IssuerXHR();
    xhr.open("POST", "/api/offers-search", true);
    xhr.send(body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(window.__nextcardBofaLocation).toEqual({
      latitude: 37,
      longitude: -122,
      sessionHash: Buffer.from(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode("synthetic-issuer-session"),
        ),
      ).toString("hex"),
    });
    expect(sent).toEqual([
      ["https://unrelated.example/api/offers-search", { body }],
      ["/api/activate-offer/123", { body }],
      ["POST", "/api/offers-search", true, null, null],
      body,
    ]);
  });
});
