/** Loyalty identifiers are display-only suffixes. Full values must never be persisted. */
export function redactLoyaltyIdentifier(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 4
    ? "*".repeat(trimmed.length - 4) + trimmed.slice(-4)
    : trimmed;
}

const identifierKeys = new Set([
  "membernumber",
  "membershipnumber",
  "loyaltynumber",
  "accountnumber",
  "certificatenumber",
  "certificatecode",
  "companionfarecode",
  "companioncode",
  "confirmationcode",
  "discountcode",
  "vouchercode",
  "rewardcode",
  "code",
  "pin"
]);

function isIdentifierKey(key: string) {
  return identifierKeys.has(key.toLowerCase().replace(/[^a-z]/g, ""));
}

/** Covers nested/raw payloads, tracking edit history, and copies of codes in descriptions. */
export function redactLoyaltyIdentifiers(value: unknown): unknown {
  const identifiers = new Set<string>();
  function collect(input: unknown, sensitive = false) {
    if (typeof input === "string" || typeof input === "number") {
      if (sensitive && String(input).length > 4) identifiers.add(String(input));
      return;
    }
    if (!input || typeof input !== "object") return;
    if (Array.isArray(input)) {
      for (const item of input) collect(item, sensitive);
      return;
    }
    const fields = Object.fromEntries(Object.entries(input));
    const identifierContent =
      (typeof fields.key === "string" && isIdentifierKey(fields.key)) ||
      (typeof fields.label === "string" && isIdentifierKey(fields.label));
    for (const [key, item] of Object.entries(input)) {
      collect(
        item,
        isIdentifierKey(key) ||
          ((sensitive || identifierContent) &&
            ["value", "content", "state", "history"].includes(key))
      );
    }
  }
  collect(value);
  const replacements = [...identifiers].sort(
    (left, right) => right.length - left.length
  );
  function redact(input: unknown, sensitive = false): unknown {
    if (typeof input === "string") {
      let text = sensitive ? redactLoyaltyIdentifier(input) : input;
      for (const identifier of replacements) {
        text = text.split(identifier).join(redactLoyaltyIdentifier(identifier));
      }
      return text;
    }
    if (typeof input === "number" && sensitive && Number.isFinite(input)) {
      return Number(String(input).slice(-4));
    }
    if (!input || typeof input !== "object") return input;
    if (Array.isArray(input))
      return input.map((item) => redact(item, sensitive));
    const fields = Object.fromEntries(Object.entries(input));
    const identifierContent =
      (typeof fields.key === "string" && isIdentifierKey(fields.key)) ||
      (typeof fields.label === "string" && isIdentifierKey(fields.label));
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [
        key,
        redact(
          item,
          isIdentifierKey(key) ||
            ((sensitive || identifierContent) &&
              ["value", "content", "state", "history"].includes(key))
        )
      ])
    );
  }
  return redact(value);
}
