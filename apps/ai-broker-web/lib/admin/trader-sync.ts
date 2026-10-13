/**
 * @fileoverview Refreshes one copy-trading source's leaders from its upstream
 * API into D1, for the admin "top traders" section's sync button.
 */
import { syncLeaderboard } from "@/packages/investing/src/prediction";
import { syncZuluTraders } from "@/packages/investing/src/leaders/zulu";
import { syncCopyTradingLeadersOrders } from "@/packages/investing/src/leaders/nvsty-leaders";
import type { TraderSource } from "./traders";

/** Most Polymarket leaderboard rows one admin sync pulls (the API pages by 50). */
export const MAX_POLYMARKET_SYNC = 500;

export async function syncTraderSource(
  source: TraderSource,
  options: { limit?: number; orderBy?: "PNL" | "VOL" } = {},
): Promise<{ source: TraderSource; synced: number }> {
  if (source === "polymarket") {
    const limit = Math.min(MAX_POLYMARKET_SYNC, Math.max(1, Math.floor(options.limit ?? 100)));
    const result = await syncLeaderboard({
      limit,
      orderBy: options.orderBy === "VOL" ? "VOL" : "PNL",
      timePeriod: "all",
    });
    return { source, synced: result.leaders };
  }
  if (source === "zulu") {
    const result = await syncZuluTraders({ limit: options.limit });
    return { source, synced: result.traders };
  }
  // Resolves to the array of leaders it saved.
  const result: unknown = await syncCopyTradingLeadersOrders();
  return { source, synced: Array.isArray(result) ? result.length : 0 };
}
