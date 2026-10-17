import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../../db";
import { polymarketMarkets } from "../../db/schema";
import { syncMarketsIncremental } from "./incremental-markets";
import { clampRefillSize } from "./refill-limits";

export { MAX_REFILL_MARKETS, clampRefillSize } from "./refill-limits";

export interface RefillMarketsOptions {
  /** Markets to pull from Polymarket, by 24h volume (default: 500, capped at MAX_REFILL_MARKETS). */
  maxMarkets?: number;
  /** Also sync price history for each market (default: false — slow). */
  priceHistory?: boolean;
  /** Also sync top holders for each market (default: false — slow). */
  holders?: boolean;
  /** Mark markets whose end date has passed as inactive (default: true). */
  deactivateExpired?: boolean;
  /** Clock override for tests. */
  now?: Date;
}

export interface RefillMarketsResult {
  markets: number;
  pricePoints: number;
  holders: number;
  deactivated: number;
}

/**
 * Marks every market whose `end_date` is before `now` as inactive, so resolved
 * markets stop showing in the public lists. The incremental sync only fetches
 * open markets, so without this a market that closed between syncs keeps its
 * last `active=true` forever. `end_date` is an ISO-8601 string, which sorts
 * lexically in time order.
 */
export async function deactivateExpiredMarkets(now = new Date()): Promise<number> {
  const rows = await db
    .update(polymarketMarkets)
    .set({ active: false, updatedAt: now })
    .where(
      and(
        eq(polymarketMarkets.active, true),
        isNotNull(polymarketMarkets.endDate),
        lt(polymarketMarkets.endDate, now.toISOString()),
      ),
    )
    .returning({ id: polymarketMarkets.id });
  return rows.length;
}

/**
 * Refills the prediction-market table from Polymarket: upserts the top open
 * markets by volume (never deleting, so admin publish decisions and price
 * history survive) and retires markets that have ended.
 */
export async function refillMarkets(
  options: RefillMarketsOptions = {},
): Promise<RefillMarketsResult> {
  const {
    priceHistory = false,
    holders = false,
    deactivateExpired = true,
    now = new Date(),
  } = options;
  const maxMarkets = clampRefillSize(options.maxMarkets);

  const synced = await syncMarketsIncremental(maxMarkets, priceHistory, holders);
  const deactivated = deactivateExpired ? await deactivateExpiredMarkets(now) : 0;

  return {
    markets: synced.markets ?? 0,
    pricePoints: synced.pricePoints ?? 0,
    holders: synced.holders ?? 0,
    deactivated,
  };
}
