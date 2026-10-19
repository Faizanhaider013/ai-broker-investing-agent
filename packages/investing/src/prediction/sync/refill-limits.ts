/**
 * Refill size limits, kept apart from refill.ts so callers that only validate
 * input (route handlers, tests) do not import the database client.
 */

/** Upper bound an admin refill may request, so one click cannot run all night. */
export const MAX_REFILL_MARKETS = 5000;

/** Clamps a requested refill size to 1…MAX_REFILL_MARKETS (0 or junk → default). */
export function clampRefillSize(value: unknown, fallback = 500): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, MAX_REFILL_MARKETS);
}
