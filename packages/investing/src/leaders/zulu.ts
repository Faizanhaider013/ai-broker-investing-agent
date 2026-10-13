import { db } from "../db";
import { zuluTraders, zuluCurrencyStats } from "../db/schema";
import { eq, desc, asc, sql } from "drizzle-orm";

// ============================================================================
// Fetching Functions
// ============================================================================

const ZULU_GATEWAY = "https://www.zulutrade.com/zulutrade-gateway";

/** Most traders one list sync saves (one D1 upsert each). */
export const MAX_ZULU_SYNC = 200;
const DEFAULT_ZULU_SYNC = 100;
const ZULU_TIMEOUT_MS = 20_000;

/**
 * ZuluTrade's gateway is a browser API, and Workers' fetch sends no
 * User-Agent or Origin by default, so send the ones its own site would. The
 * `sec-fetch-*` headers the old code sent are browser-controlled and only
 * made the request look forged.
 */
const ZULU_HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  origin: "https://www.zulutrade.com",
  referer: "https://www.zulutrade.com/",
};

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/** GETs a ZuluTrade gateway URL and parses JSON, with errors that say what went wrong. */
async function zuluGet(url: string, label: string): Promise<any> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: ZULU_HEADERS,
      signal: AbortSignal.timeout(ZULU_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} request failed: ${reason}`);
  }

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw new Error(`${label} failed: HTTP ${resp.status}${text ? ` — ${snippet(text)}` : ""}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned a non-JSON response (likely a bot check): ${snippet(text)}`);
  }
}

export async function fetchZuluTraders(): Promise<any[]> {
  const data = await zuluGet(
    `${ZULU_GATEWAY}/api/providers/performance/topTraders/75932/search?flavorId=1&accessingFlavorId=1`,
    "Zulu top traders fetch",
  );
  if (!Array.isArray(data?.result)) {
    throw new Error(
      `Zulu top traders fetch returned an unexpected shape (no \`result\` array): ${snippet(JSON.stringify(data ?? null))}`,
    );
  }
  return data.result;
}

export async function fetchZuluTraderDetail(providerId: number) {
  return zuluGet(
    `${ZULU_GATEWAY}/v2/api/providers/${providerId}/thi/init?accessingFlavorId=1&flavor=global`,
    `Zulu trader ${providerId} detail fetch`,
  );
}

// ============================================================================
// Normalization
// ============================================================================

/**
 * Timeframes (in days) to read per-period stats from, in order of preference.
 * The top-traders list carries only "180"; the detail endpoint carries every
 * period from "1" up, so taking the first key there read 1-day stats.
 */
const PREFERRED_TIMEFRAMES = ["180", "365", "10000", "90", "30"];

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function date(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value) : null;
}

function pickTimeframe(timeframeStats: unknown): Record<string, any> {
  if (!timeframeStats || typeof timeframeStats !== "object") return {};
  const byId = timeframeStats as Record<string, any>;
  for (const id of PREFERRED_TIMEFRAMES) {
    if (byId[id] && typeof byId[id] === "object") return byId[id];
  }
  const first = Object.values(byId)[0];
  return first && typeof first === "object" ? first : {};
}

export interface NormalizedZuluTrader {
  row: typeof zuluTraders.$inferInsert & { providerId: number };
  currencyStats: any[];
}

/**
 * Maps one ZuluTrade trader into a `zulu_traders` row. Accepts both shapes
 * the gateway serves: a top-traders list element (`{ trader: {...} }`, with
 * `timeframeStats` and `currencyStats` nested in `overallStats`) and a detail
 * `trader.stats` object (with them as siblings of `overallStats`). Returns
 * null for an element without a provider id or profile instead of throwing,
 * so one malformed entry can't abort the whole sync.
 */
export function normalizeZuluTrader(raw: any, now = new Date()): NormalizedZuluTrader | null {
  const trader = raw?.trader && typeof raw.trader === "object" ? raw.trader : raw;
  const providerId = trader?.providerId ?? trader?.profile?.id;
  const profile = trader?.profile;
  if (typeof providerId !== "number" || !Number.isFinite(providerId) || !profile) return null;

  const stats = trader.overallStats ?? {};
  const tf = pickTimeframe(trader.timeframeStats ?? stats.timeframeStats);
  const currencyStats = Array.isArray(trader.currencyStats)
    ? trader.currencyStats
    : Array.isArray(stats.currencyStats)
      ? stats.currencyStats
      : [];

  return {
    row: {
      providerId,
      name: profile.name ?? null,
      strategyDesc: profile.strategyDesc || null,
      countryCode: profile.countryIsoCode ?? null,
      countryName: profile.countryName ?? null,
      brokerName: profile.brokerName ?? null,
      balance: num(stats.balance),
      equity: num(stats.equity),
      followers: num(stats.followers),
      liveFollowers: num(stats.liveFollowers),
      roiAnnualized: num(stats.roiAnnualized),
      roiProfit: num(stats.roiProfit),
      zuluRank: num(stats.zuluRank),
      bestTrade: num(stats.bestTrade),
      worstTrade: num(stats.worstTrade),
      profitableTrades: num(stats.profitableTrades),
      losingTrades: num(stats.losingTrades),
      avgDrawdown: num(stats.avgDrawdown),
      maxDrawdown: num(stats.overallDrawDownInMoney ?? stats.overallDrawDownMoney),
      maxDrawdownPercent: num(tf.maxDrawDownPercent ?? stats.overallDrawDownPercent),
      leverage: num(profile.leverage),
      isEa: trader.badges?.ea || trader.badges?.isEa || profile.ea ? 1 : 0,
      currencies: typeof stats.providerCurrencies === "string" ? stats.providerCurrencies : "",
      weeks: num(stats.weeks),
      demo: profile.demo ? 1 : 0,
      avgTradeSeconds: Math.round(num(tf.avgTradeSeconds)),
      avgPnlPerTrade: num(tf.avgPnlPerTrade),
      winRate: num(tf.winTrades),
      totalTrades: num(tf.trades),
      pageVisits: num(profile.pageVisits),
      includedInWatchlist: num(stats.includedInWatchlist),
      registrationDate: date(profile.registrationDate),
      lastOpenTradeDate: date(stats.lastOpenTradeDate),
      updatedAt: now,
    },
    currencyStats,
  };
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Upserts traders into `zulu_traders`, skipping malformed entries. Currency
 * stats cost one query per instrument, so the bulk list sync turns them off
 * to stay inside D1's per-invocation query limit.
 *
 * @returns how many traders were saved
 */
export async function saveZuluTraders(
  traders: any[],
  options: { currencyStats?: boolean } = {},
): Promise<number> {
  const now = new Date();
  let saved = 0;

  for (const raw of traders) {
    const normalized = normalizeZuluTrader(raw, now);
    if (!normalized) continue;
    const { providerId: _id, ...set } = normalized.row;

    await db
      .insert(zuluTraders)
      .values(normalized.row)
      .onConflictDoUpdate({ target: zuluTraders.providerId, set });
    saved++;

    if (options.currencyStats !== false && normalized.currencyStats.length > 0) {
      await saveZuluCurrencyStats(normalized.row.providerId, normalized.currencyStats);
    }
  }

  return saved;
}

export async function saveZuluCurrencyStats(providerId: number, stats: any[]) {
  const now = Date.now();

  for (const stat of stats) {
    if (!stat?.currencyName) continue;
    const id = `${providerId}-${stat.currencyName}`;

    await db
      .insert(zuluCurrencyStats)
      .values({
        id,
        providerId,
        currencyName: stat.currencyName,
        totalCount: stat.totalCurrencyCount || 0,
        winCount: stat.currencyWinCount || 0,
        winPercent: stat.currencyWinPercent || 0,
        totalBuyCount: stat.totalCurrencyBuyCount || 0,
        totalSellCount: stat.totalCurrencySellCount || 0,
        pips: stat.pips || 0,
        createdAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: zuluCurrencyStats.id,
        set: {
          totalCount: stat.totalCurrencyCount || 0,
          winCount: stat.currencyWinCount || 0,
          winPercent: stat.currencyWinPercent || 0,
          totalBuyCount: stat.totalCurrencyBuyCount || 0,
          totalSellCount: stat.totalCurrencySellCount || 0,
          pips: stat.pips || 0,
        },
      });
  }
}

// ============================================================================
// Query Functions
// ============================================================================

export async function getZuluTraders(limit = 50) {
  return await db
    .select()
    .from(zuluTraders)
    .orderBy(desc(zuluTraders.roiAnnualized))
    .limit(limit);
}

export async function getZuluTraderById(providerId: number) {
  const trader = await db
    .select()
    .from(zuluTraders)
    .where(eq(zuluTraders.providerId, providerId))
    .limit(1);

  if (trader.length === 0) return null;

  const currencies = await db
    .select()
    .from(zuluCurrencyStats)
    .where(eq(zuluCurrencyStats.providerId, providerId));

  return {
    ...trader[0],
    currencyStats: currencies,
  };
}

export async function getZuluTopByRank(limit = 50) {
  return await db
    .select()
    .from(zuluTraders)
    // Unranked traders are stored as 0; keep them after every ranked one.
    .orderBy(sql`case when ${zuluTraders.zuluRank} > 0 then 0 else 1 end`, asc(zuluTraders.zuluRank))
    .limit(limit);
}

export async function searchZuluTraders(filters: any) {
  let query = db.select().from(zuluTraders);

  if (filters.minRoi) {
    query = query.where(
      sql`${zuluTraders.roiAnnualized} >= ${filters.minRoi}`
    ) as any;
  }
  if (filters.minWinRate) {
    query = query.where(
      sql`${zuluTraders.winRate} >= ${filters.minWinRate}`
    ) as any;
  }
  if (filters.maxDrawdown) {
    query = query.where(
      sql`${zuluTraders.maxDrawdownPercent} <= ${filters.maxDrawdown}`
    ) as any;
  }
  if (filters.isEa !== undefined) {
    query = query.where(eq(zuluTraders.isEa, filters.isEa ? 1 : 0)) as any;
  }

  return await query
    .orderBy(desc(zuluTraders.roiAnnualized))
    .limit(filters.limit || 50);
}

// ============================================================================
// Main Sync Functions
// ============================================================================

export async function syncZuluTraders(options: { limit?: number } = {}) {
  const limit = Math.min(MAX_ZULU_SYNC, Math.max(1, Math.floor(options.limit ?? DEFAULT_ZULU_SYNC)));
  console.log(`Starting Zulu sync (up to ${limit} traders)...`);

  const fetched = await fetchZuluTraders();
  const saved = await saveZuluTraders(fetched.slice(0, limit), { currencyStats: false });

  console.log(`Saved ${saved} of ${fetched.length} Zulu traders`);
  if (fetched.length > 0 && saved === 0) {
    throw new Error(`ZuluTrade returned ${fetched.length} traders but none had a provider id and profile`);
  }

  return { traders: saved, fetched: fetched.length };
}

export async function syncZuluTraderDetails(providerIds: number[]) {
  console.log(`Syncing details for ${providerIds.length} traders...`);

  const details = [];
  for (const id of providerIds) {
    try {
      const detail = await fetchZuluTraderDetail(id);
      if (detail?.trader?.stats) details.push(detail.trader.stats);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error: any) {
      console.error(`Failed to fetch trader ${id}:`, error.message);
    }
  }

  const saved = details.length > 0 ? await saveZuluTraders(details) : 0;

  console.log(`Saved ${saved} trader details`);
  return { details: saved };
}
