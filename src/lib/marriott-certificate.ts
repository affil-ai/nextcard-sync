const MARRIOTT_ACTIVITY_DATE =
  /(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\s*(?=(?:Refunded|Redeemed|Cancelled|Canceled|Awarded|Expired)\b)/i;

const MARRIOTT_ACTIVITY_STATUS =
  /(?:Refunded|Redeemed|Cancelled|Canceled|Awarded)\s*:/i;

const MARRIOTT_EXPIRY_LABEL =
  /(?:Expires?|Expiration|Valid\s+(?:through|until|thru))\b/i;

function earliestBoundary(value: string, patterns: RegExp[]) {
  let boundary = value.length;
  for (const pattern of patterns) {
    const index = value.search(pattern);
    if (index >= 0) boundary = Math.min(boundary, index);
  }
  return boundary;
}

export function extractMarriottAwardDescription(
  text: string,
  awardType: string,
) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (awardType === "Club Level Upgrade") {
    const match = normalized.match(
      /(Club\s+Level\s+Upgrade\s+Up\s+To\s+\d+\s+Nights?\s*-\s*\d+)/i,
    );
    return match?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  }

  const start = normalized.search(
    /(?:Free|Suite)\s+Night\s+Award\s+valued\s+up\s+to\s+[\w\d,]+\s*(?:pts|points)?/i,
  );
  if (start < 0) return null;

  const candidate = normalized.slice(start);
  const duplicateAwardIndex = candidate.slice(1).search(
    /(?:Free|Suite)\s+Night\s+Award\s+valued\s+up\s+to/i,
  );
  let boundary = earliestBoundary(candidate, [
    MARRIOTT_EXPIRY_LABEL,
    MARRIOTT_ACTIVITY_DATE,
    MARRIOTT_ACTIVITY_STATUS,
  ]);
  if (duplicateAwardIndex >= 0) {
    boundary = Math.min(boundary, duplicateAwardIndex + 1);
  }

  const description = candidate
    .slice(0, boundary)
    .replace(/\s*[·|–—-]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return description || null;
}

export function createMarriottCertificateKey(options: {
  type: string;
  description: string;
  expiryDate: string | null;
}) {
  return [
    options.type,
    options.description,
    options.expiryDate ?? "",
  ].map((value) => value.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
}
