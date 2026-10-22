/**
 * @fileoverview The admin "top traders" list: the leaders each copy-trading
 * source has synced into D1 (Polymarket, ZuluTrade, NVSTLY), mapped into one
 * row shape so the admin page renders them with a single table.
 */
import { desc, isNotNull, sql } from "drizzle-orm";
import { nvstlyLeaders, polymarketLeaders, zuluTraders } from "@/lib/db/schema";
import type { AdminDB } from "./db";

export const TRADER_SOURCES = ["polymarket", "zulu", "nvstly"] as const;
export type TraderSource = (typeof TRADER_SOURCES)[number];

export const TRADER_SORTS = ["pnl", "vol", "winRate", "rank"] as const;
export type TraderSort = (typeof TRADER_SORTS)[number];

export function isTraderSource(value: unknown): value is TraderSource {
  return typeof value === "string" && (TRADER_SOURCES as readonly string[]).includes(value);
}

export function isTraderSort(value: unknown): value is TraderSort {
  return typeof value === "string" && (TRADER_SORTS as readonly string[]).includes(value);
}

export interface TopTrader {
  source: TraderSource;
  id: string;
  rank: number;
  name: string;
  /** Profit in USD where the source reports one, else its gain/ROI figure. */
  pnl: number | null;
  volume: number | null;
  /** Win rate as a percentage, 0–100. */
  winRate: number | null;
  profileUrl: string | null;
  image: string | null;
  updatedAt: Date | null;
}

export const MAX_TRADERS = 200;

/** Win rates arrive as either a 0–1 fraction or a 0–100 percentage. */
export function toPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function shortWallet(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Top traders for one source, ranked by the requested metric. `rank` in the
 * result is the position in this list, not the source's own rank (which the
 * Polymarket leaderboard reports per its own ordering).
 */
export async function loadTopTraders(
  db: AdminDB,
  options: { source: TraderSource; sort?: TraderSort; limit?: number },
): Promise<TopTrader[]> {
  const limit = Math.min(MAX_TRADERS, Math.max(1, Math.floor(options.limit ?? 50)));
  const sort = options.sort ?? "pnl";

  if (options.source === "polymarket") {
    const order =
      sort === "vol"
        ? desc(polymarketLeaders.vol)
        : sort === "winRate"
          ? desc(polymarketLeaders.winRate)
          : sort === "rank"
            ? sql`${polymarketLeaders.rank} is null, ${polymarketLeaders.rank} asc`
            : desc(sql`coalesce(${polymarketLeaders.pnl}, ${polymarketLeaders.overallGain})`);
    const rows = await db.select().from(polymarketLeaders).orderBy(order).limit(limit);
    return rows.map((t, i) => ({
      source: "polymarket" as const,
      id: t.trader,
      rank: i + 1,
      name: t.userName || shortWallet(t.trader),
      pnl: t.pnl ?? t.overallGain ?? null,
      volume: t.vol ?? null,
      winRate: toPercent(t.winRate),
      profileUrl: `https://polymarket.com/profile/${t.trader}`,
      image: t.profileImage ?? null,
      updatedAt: t.updatedAt ?? null,
    }));
  }

  if (options.source === "zulu") {
    const order =
      sort === "winRate"
        ? desc(zuluTraders.winRate)
        : sort === "vol"
          ? desc(zuluTraders.totalTrades)
          : sort === "rank"
            ? sql`${zuluTraders.zuluRank} is null, ${zuluTraders.zuluRank} asc`
            : desc(zuluTraders.roiProfit);
    const rows = await db
      .select()
      .from(zuluTraders)
      .where(isNotNull(zuluTraders.providerId))
      .orderBy(order)
      .limit(limit);
    return rows.map((t, i) => ({
      source: "zulu" as const,
      id: String(t.providerId),
      rank: i + 1,
      name: t.name || `Trader ${t.providerId}`,
      pnl: t.roiProfit ?? null,
      volume: t.totalTrades ?? null,
      winRate: toPercent(t.winRate),
      profileUrl: `https://www.zulutrade.com/trader/${t.providerId}`,
      image: null,
      updatedAt: t.updatedAt ?? null,
    }));
  }

  const order =
    sort === "winRate"
      ? desc(nvstlyLeaders.winRate)
      : sort === "vol"
        ? desc(nvstlyLeaders.trades)
        : sort === "rank"
          ? sql`${nvstlyLeaders.rank} is null, ${nvstlyLeaders.rank} asc`
          : desc(nvstlyLeaders.totalGain);
  const rows = await db.select().from(nvstlyLeaders).orderBy(order).limit(limit);
  return rows.map((t, i) => ({
    source: "nvstly" as const,
    id: t.id,
    rank: i + 1,
    name: t.name,
    pnl: t.totalGain ?? null,
    volume: t.trades ?? null,
    winRate: toPercent(t.winRate),
    profileUrl: null,
    image: null,
    updatedAt: t.updatedAt ?? null,
  }));
}

/** How many leaders each source currently has in D1, for the section header. */
export async function countTradersBySource(db: AdminDB): Promise<Record<TraderSource, number>> {
  const [[poly], [zulu], [nvstly]] = await Promise.all([
    db.select({ value: sql<number>`count(*)` }).from(polymarketLeaders),
    db.select({ value: sql<number>`count(*)` }).from(zuluTraders),
    db.select({ value: sql<number>`count(*)` }).from(nvstlyLeaders),
  ]);
  return {
    polymarket: Number(poly?.value ?? 0),
    zulu: Number(zulu?.value ?? 0),
    nvstly: Number(nvstly?.value ?? 0),
  };
}
