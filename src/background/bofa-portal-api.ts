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
    if (kind === "session") return { portalId, status: 200, data: null };
    let proximity: { latitude: number; longitude: number } | undefined;
    try {
      const stored: unknown = JSON.parse(
        localStorage.getItem("geo_fallback_location") || "null",
      );
      if (
        stored &&
        typeof stored === "object" &&
        "latitude" in stored &&
        "longitude" in stored &&
        typeof stored.latitude === "number" &&
        typeof stored.longitude === "number"
      )
        proximity = { latitude: stored.latitude, longitude: stored.longitude };
    } catch {
      /* The portal may be using its current location instead. */
    }
    if (!proximity && kind !== "activate") {
      const permission = await navigator.permissions.query({
        name: "geolocation",
      });
      if (permission.state !== "granted")
        throw new Error(
          "Set and save your location in the BofA portal, then check again.",
        );
      proximity = await new Promise<{ latitude: number; longitude: number }>(
        (resolve, reject) =>
          navigator.geolocation.getCurrentPosition(
            (p) =>
              resolve({
                latitude: p.coords.latitude,
                longitude: p.coords.longitude,
              }),
            () =>
              reject(
                new Error(
                  "Set and save your location in the BofA portal, then check again.",
                ),
              ),
            { timeout: 10000, maximumAge: 300000 },
          ),
      );
    }
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
