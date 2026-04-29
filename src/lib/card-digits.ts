export function extractLastFourDigits(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length < 4) return null;
  return digits.slice(-4);
}
