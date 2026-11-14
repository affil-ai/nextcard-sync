export function extractLastFourDigits(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * American Express identifies cards by five digits ("••••61008"), so two Amex
 * cards can share their last 4. Keep the issuer's whole suffix (up to five
 * digits) from the last run of digits, so a number earlier in a card name
 * can't become a fifth digit. nextcard accepts four or five.
 */
export function extractCardSuffixDigits(value: string | null | undefined): string | null {
  const run = value?.match(/\d+(?=\D*$)/)?.[0] ?? "";
  if (run.length < 4) return null;
  return run.slice(-5);
}

/** Equal, or one side lacks Amex's fifth digit. Different five-digit suffixes never match. */
export function sameCardSuffix(left: string, right: string): boolean {
  return left === right || (left.length !== right.length && left.slice(-4) === right.slice(-4));
}
