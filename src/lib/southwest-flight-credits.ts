function normalizeText(value: string | null | undefined) {
  return value?.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() ?? "";
}

export function summarizeSouthwestFlightCredits(
  sectionText: string | null | undefined,
) {
  const normalized = normalizeText(sectionText);
  if (!normalized) return null;

  if (
    /you (?:do not|don['’]t) have any (?:available )?flight credits?/i.test(
      normalized,
    )
  ) {
    return "No available flight credits";
  }

  const explicitCount = normalized.match(
    /\b(\d+)\s+(?:available\s+)?flight credits?\b/i,
  );
  const explicitCountValue = explicitCount?.[1];
  if (explicitCountValue) {
    const count = Number.parseInt(explicitCountValue, 10);
    if (Number.isFinite(count)) {
      return `${count} flight ${count === 1 ? "credit" : "credits"}`;
    }
  }

  const confirmationCodes = new Set(
    Array.from(normalized.matchAll(/#\s*([A-Z0-9]{6})\b/gi))
      .flatMap((match) => (match[1] ? [match[1].toUpperCase()] : [])),
  );
  if (confirmationCodes.size > 0) {
    return `${confirmationCodes.size} flight ${
      confirmationCodes.size === 1 ? "credit" : "credits"
    }`;
  }

  return null;
}
