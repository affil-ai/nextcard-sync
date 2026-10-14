/** Runs in the issuer's MAIN world before its application starts. */
declare global {
  interface Window {
    __nextcardBofaLocation?: {
      latitude: number;
      longitude: number;
      sessionHash: string;
    };
  }
}

export function captureBofaLocationContext() {
  const paths = new Set([
    "/api/offers-home",
    "/api/offers-search",
    "/api/offers-details",
  ]);
  const requests = new WeakMap<XMLHttpRequest, string>();
  function token() {
    return (
      new URLSearchParams(location.search).get("token") ||
      localStorage.getItem("LS_TOKEN")
    );
  }
  function record(url: string | URL, body: unknown) {
    try {
      const target = new URL(url, location.href);
      if (
        target.origin !== "https://deals.merchant-rewards.com" ||
        !paths.has(target.pathname) ||
        typeof body !== "string"
      )
        return;
      const parsed: unknown = JSON.parse(body);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("proximity_target" in parsed)
      )
        return;
      const point = parsed.proximity_target;
      if (
        !point ||
        typeof point !== "object" ||
        !("latitude" in point) ||
        !("longitude" in point) ||
        typeof point.latitude !== "number" ||
        typeof point.longitude !== "number" ||
        !Number.isFinite(point.latitude) ||
        !Number.isFinite(point.longitude)
      )
        return;
      const session = token();
      if (!session) return;
      const latitude = point.latitude;
      const longitude = point.longitude;
      void crypto.subtle
        .digest("SHA-256", new TextEncoder().encode(session))
        .then((bytes) => {
          if (token() !== session) return;
          // Neither coordinates nor the issuer session hash leave this page.
          window.__nextcardBofaLocation = {
            latitude,
            longitude,
            sessionHash: Array.from(new Uint8Array(bytes), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join(""),
          };
        })
        .catch(() => {});
    } catch {
      /* Other issuer requests must continue without modification. */
    }
  }
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username: string | null = null,
    password: string | null = null,
  ) {
    requests.set(this, String(url));
    originalOpen.call(this, method, url, async, username, password);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const url = requests.get(this);
    if (url) record(url, body);
    originalSend.call(this, body);
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === "string" || input instanceof URL)
      record(input, init?.body);
    return originalFetch(input, init);
  };
}

if (typeof window !== "undefined" && typeof XMLHttpRequest !== "undefined")
  captureBofaLocationContext();
