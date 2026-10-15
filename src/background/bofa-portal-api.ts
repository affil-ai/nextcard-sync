import type {} from "../content-scripts/bofa-location-context";
/** Serialized into the issuer page. No issuer token or raw identity leaves this function. */
export async function bofaPortalRequest(
  kind: "session" | "search" | "details" | "activate",
  expectedPortalId: string | null,
  input: number | string | null,
) {
  try {
    if (location.origin !== "https://deals.merchant-rewards.com")
      throw new Error("Open your BofA deals portal first.");
    const token =
      new URLSearchParams(location.search).get("token") ||
      localStorage.getItem("LS_TOKEN");
    if (!token)
      throw new Error("Sign in to BofA and open your deals portal first.");
    const part = token.split(".")[1];
    if (!part) throw new Error("Your BofA session is unavailable.");
    const encoded = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(
      atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")),
    );
    if (
      !claims ||
      typeof claims !== "object" ||
      !("user_id" in claims) ||
      typeof claims.user_id !== "string" ||
      !("publisher_id" in claims) ||
      typeof claims.publisher_id !== "string" ||
      !("exp" in claims) ||
      typeof claims.exp !== "number" ||
      claims.exp * 1000 <= Date.now()
    )
      throw new Error("Your BofA session expired. Open deals from BofA again.");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `nextcard:bofa-portal:v1:${claims.publisher_id}:${claims.user_id}`,
      ),
    );
    const portalId = `v1:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (expectedPortalId !== null && portalId !== expectedPortalId)
      throw new Error("Your BofA portal account changed. Check offers again.");
    const sessionBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(token),
    );
    const sessionHash = Array.from(new Uint8Array(sessionBytes), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const captured = window.__nextcardBofaLocation;
    const locationContext =
      captured?.sessionHash === sessionHash ? captured : undefined;
    if (kind === "session")
      return {
        portalId,
        status: 200,
        data: null,
        hasLocationContext: locationContext !== undefined,
        expiresAt: claims.exp * 1000,
      };
    const proximity = locationContext ? {
      latitude: locationContext.latitude,
      longitude: locationContext.longitude,
    } : undefined;
    if (!proximity && kind !== "activate")
      throw new Error("The BofA offer location changed. Check offers again.");
    let path: string;
    let body: object;
    if (
      kind === "search" &&
      typeof input === "number" &&
      Number.isInteger(input) &&
      input >= 0
    ) {
      path = "/api/offers-search";
      body = {
        apply_filter: {},
        proximity_target: proximity,
        sort_by: "merchant_name_asc",
        page_size: 24,
        page_offset: input,
      };
    } else if (
      (kind === "details" || kind === "activate") &&
      typeof input === "string" &&
      /^\d+$/.test(input)
    ) {
      path =
        kind === "details"
          ? "/api/offers-details"
          : `/api/activate-offer/${input}`;
      body =
        kind === "details"
          ? { offer_id: input, proximity_target: proximity }
          : { activation_tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
    } else throw new Error("Invalid BofA request.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method: kind === "activate" ? "PUT" : "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Cardholder-Token": token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403)
        throw new Error(
          "Your BofA session expired. Open deals from BofA again.",
        );
      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryAfterMs = Number.isFinite(seconds)
          ? Math.max(0, seconds * 1000)
          : retryAfter === null ? 0 : Math.max(0, Date.parse(retryAfter) - Date.now());
        return {
          portalId,
          status: response.status,
          data: null,
          ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
        };
      }
      const data: unknown = await response.json();
      return { portalId, status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const knownMessages = [
      "Open your BofA deals portal first.",
      "Sign in to BofA and open your deals portal first.",
      "Your BofA session is unavailable.",
      "Your BofA session expired. Open deals from BofA again.",
      "Your BofA portal account changed. Check offers again.",
      "Set and save your location in the BofA portal, then check again.",
      "Invalid BofA request.",
    ];
    const message =
      error instanceof Error && knownMessages.includes(error.message)
        ? error.message
        : "BofA could not return this request. Check your connection or reopen the portal.";
    return { error: message };
  }
}
