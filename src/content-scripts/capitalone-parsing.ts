const CAPITAL_ONE_CARD_TILE_HINTS = [
  "pay bill",
  "minimum due",
  "min $",
  "virtual card",
  "credit limit",
];

const CAPITAL_ONE_ACCOUNT_NAME_NOISE = [
  "current balance",
  "available balance",
  "minimum payment due",
  "minimum due",
  "pay bill",
  "view account",
  "get your virtual card",
  "virtual card",
];

function compactWhitespace(value: string | null | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function stripAccountNameNoise(value: string) {
  let normalized = compactWhitespace(value);

  normalized = normalized
    .replace(/\bending in\b\s*\.{0,3}\d{4}/gi, " ")
    .replace(/\.{2,}\s*\d{4}/g, " ")
    .replace(/\bmin\s+\$[\d,]+(?:\.\d{2})?\s+due\b.*$/i, " ")
    .replace(/\bcurrent balance\b.*$/i, " ");

  for (const noise of CAPITAL_ONE_ACCOUNT_NAME_NOISE) {
    normalized = normalized.replace(new RegExp(`\\b${noise}\\b`, "gi"), " ");
  }

  return compactWhitespace(normalized);
}

function isMeaningfulAccountName(value: string | null | undefined) {
  const normalized = stripAccountNameNoise(value ?? "");
  if (!normalized) return false;
  if (/^\d{4,}$/.test(normalized)) return false;
  return normalized.length > 1;
}

export function selectCapitalOneCardName(candidates: {
  imageAlt?: string | null;
  headingText?: string | null;
  identityText?: string | null;
  primaryText?: string | null;
  tileText?: string | null;
}) {
  const orderedCandidates = [
    candidates.imageAlt,
    candidates.headingText,
    candidates.identityText,
    candidates.primaryText,
    candidates.tileText,
  ];

  for (const candidate of orderedCandidates) {
    const cleaned = stripAccountNameNoise(candidate ?? "");
    if (isMeaningfulAccountName(cleaned)) {
      return cleaned;
    }
  }

  return "";
}

export function isLikelyCapitalOneCardTile(input: {
  imageSrc?: string | null;
  backgroundImage?: string | null;
  cardName?: string | null;
  primaryText?: string | null;
  tileText?: string | null;
  lastDigits?: string | null;
}) {
  if (!input.lastDigits || input.lastDigits.length < 4) {
    return false;
  }

  const brandingText = `${input.imageSrc ?? ""} ${input.backgroundImage ?? ""}`.toLowerCase();
  if (brandingText.includes("/productbranding/cc/")) {
    return true;
  }

  if (!isMeaningfulAccountName(input.cardName)) {
    return false;
  }

  const combinedText = compactWhitespace(`${input.primaryText ?? ""} ${input.tileText ?? ""}`).toLowerCase();
  return CAPITAL_ONE_CARD_TILE_HINTS.some((hint) => combinedText.includes(hint));
}

function parseWholeDollarAmount(value: string) {
  const match = value.match(/(\d[\d,]*)/);
  if (!match) return null;

  const parsed = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCentAmount(value: string) {
  const match = value.match(/\b(\d{1,2})\b/);
  if (!match) return null;

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeCapitalOneRewardsLabel(label: string | null | undefined) {
  const normalized = compactWhitespace(label).toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("cash")) return "Cash Back";
  if (normalized.includes("mile")) return "Miles";
  if (normalized.includes("point")) return "Points";
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function parseCapitalOneRewardsSummary(input: {
  balanceText?: string | null;
  dollarText?: string | null;
  centText?: string | null;
  labelText?: string | null;
}) {
  const label = normalizeCapitalOneRewardsLabel(input.labelText);
  const rawBalanceText = compactWhitespace(input.balanceText);
  const rawDollarText = compactWhitespace(input.dollarText);
  const rawCentText = compactWhitespace(input.centText);

  const wholeDollars = parseWholeDollarAmount(rawDollarText || rawBalanceText);
  if (wholeDollars == null) {
    return { amount: null, rewardsLabel: label };
  }

  const shouldTreatAsCurrency =
    rawBalanceText.includes("$") ||
    rawDollarText.includes("$") ||
    rawCentText.length > 0 ||
    label === "Cash Back";

  if (!shouldTreatAsCurrency) {
    return { amount: wholeDollars, rewardsLabel: label };
  }

  const cents = parseCentAmount(rawCentText) ?? 0;
  const amount = Number.parseFloat(`${wholeDollars}.${String(cents).padStart(2, "0")}`);
  return { amount, rewardsLabel: label };
}
