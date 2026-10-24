/**
 * Monetary values are stored as integer minor units (cents) to avoid floating-point
 * rounding. KES amounts up to ~90 trillion fit safely within Number.MAX_SAFE_INTEGER.
 */
export const toCents = (kes: number) => Math.round(kes * 100);
export const fromCents = (cents: number) => cents / 100;

/** Percentage helper that never divides by zero; returns null when undefined. */
export function percent(numerator: number | null | undefined, denominator: number | null | undefined, dp = 2): number | null {
  if (numerator == null || denominator == null || denominator === 0) return null;
  const f = 10 ** dp;
  return Math.round((numerator / denominator) * 100 * f) / f;
}
