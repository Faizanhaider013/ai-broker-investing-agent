/**
 * @fileoverview Admin publishing controls for what the public site lists:
 * Polymarket prediction markets and stocks.
 *
 * Decisions live in `listing_controls` (see its schema docstring), keyed by
 * `${kind}:${itemId}`, never on the synced tables themselves — a market sync
 * rewrites `polymarket_markets` and would otherwise reset them.
 *
 * Every function takes the drizzle handle as its first argument so tests can
 * run it against a real in-memory SQLite database.
 */
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { listingControls, polymarketMarkets } from "@/packages/investing/src/db/schema";
import type { AdminDB } from "./db";

export const PM_MARKET_KIND = "pm-market";
export const STOCK_KIND = "stock";
export type ListingKind = typeof PM_MARKET_KIND | typeof STOCK_KIND;

export const MARKET_STATUS_FILTERS = ["all", "published", "unpublished"] as const;
export type MarketStatusFilter = (typeof MARKET_STATUS_FILTERS)[number];

export const MARKET_SORTS = ["volume24hr", "volumeTotal", "updatedAt", "endDate"] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];

/** Most ids one bulk publish call may touch; D1 caps bound parameters per statement. */
export const MAX_BULK_IDS = 50;

export function listingId(kind: ListingKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

/**
 * Upper-cases and validates a ticker: letters, digits and the `.`, `-`, `^`
 * and `=` that index, class-share and FX symbols use (BRK.B, ^GSPC, EURUSD=X).
 * Returns null for anything else.
 */
export function normalizeSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const symbol = raw.trim().toUpperCase();
  return /^[A-Z0-9.^=-]{1,15}$/.test(symbol) ? symbol : null;
}

/** Correlated "this market has an unpublished row" condition. */
function unpublishedMarket(): SQL {
  return sql`exists (select 1 from ${listingControls} where ${listingControls.kind} = ${PM_MARKET_KIND} and ${listingControls.itemId} = ${polymarketMarkets.id} and ${listingControls.published} = 0)`;
}

export interface AdminMarketQuery {
  q?: string;
  category?: string;
  status?: MarketStatusFilter;
  activeOnly?: boolean;
  sort?: MarketSort;
  page?: number;
  limit?: number;
}

export interface AdminMarketRow {
  id: string;
  question: string;
  slug: string;
  eventSlug: string | null;
  category: string | null;
  image: string | null;
  volume24hr: number | null;
  volumeTotal: number | null;
  active: boolean | null;
  closed: boolean | null;
  endDate: string | null;
  updatedAt: Date;
  published: boolean;
  note: string | null;
  controlUpdatedBy: string | null;
  controlUpdatedAt: Date | null;
}

/**
 * One page of markets with their publish state, for the admin markets table,
 * plus totals for the status strip. Search matches the question, slug or id.
 */
export async function listMarketsForAdmin(db: AdminDB, query: AdminMarketQuery = {}) {
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 25)));
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const status = query.status ?? "all";
  const sort = query.sort ?? "volume24hr";

  const filters: SQL[] = [];
  const q = query.q?.trim();
  if (q) {
    const pattern = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    filters.push(
      or(
        sql`${polymarketMarkets.question} like ${pattern} escape '\\'`,
        sql`${polymarketMarkets.slug} like ${pattern} escape '\\'`,
        eq(polymarketMarkets.id, q),
      ) as SQL,
    );
  }
  if (query.category && query.category !== "all") {
    filters.push(eq(polymarketMarkets.category, query.category));
  }
  if (query.activeOnly) {
    filters.push(eq(polymarketMarkets.active, true));
  }
  const baseWhere = filters.length ? and(...filters) : undefined;

  const statusFilter =
    status === "unpublished"
      ? unpublishedMarket()
      : status === "published"
        ? sql`not ${unpublishedMarket()}`
        : undefined;
  const where = statusFilter ? and(baseWhere, statusFilter) : baseWhere;

  const sortColumn =
    sort === "volumeTotal"
      ? polymarketMarkets.volumeTotal
      : sort === "updatedAt"
        ? polymarketMarkets.updatedAt
        : sort === "endDate"
          ? polymarketMarkets.endDate
          : polymarketMarkets.volume24hr;

  const [rows, [matched], [totals]] = await Promise.all([
    db
      .select({
        id: polymarketMarkets.id,
        question: polymarketMarkets.question,
        slug: polymarketMarkets.slug,
        eventSlug: polymarketMarkets.eventSlug,
        category: polymarketMarkets.category,
        image: polymarketMarkets.image,
        volume24hr: polymarketMarkets.volume24hr,
        volumeTotal: polymarketMarkets.volumeTotal,
        active: polymarketMarkets.active,
        closed: polymarketMarkets.closed,
        endDate: polymarketMarkets.endDate,
        updatedAt: polymarketMarkets.updatedAt,
        controlPublished: listingControls.published,
        note: listingControls.note,
        controlUpdatedBy: listingControls.updatedBy,
        controlUpdatedAt: listingControls.updatedAt,
      })
      .from(polymarketMarkets)
      .leftJoin(
        listingControls,
        and(
          eq(listingControls.kind, PM_MARKET_KIND),
          eq(listingControls.itemId, polymarketMarkets.id),
        ),
      )
      .where(where)
      .orderBy(sort === "endDate" ? asc(sortColumn) : desc(sortColumn), asc(polymarketMarkets.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ value: count() }).from(polymarketMarkets).where(where),
    db
      .select({
        total: count(),
        unpublished: sql<number>`coalesce(sum(case when ${unpublishedMarket()} then 1 else 0 end), 0)`,
      })
      .from(polymarketMarkets)
      .where(baseWhere),
  ]);

  const markets: AdminMarketRow[] = rows.map(({ controlPublished, ...row }) => ({
    ...row,
    // No control row means the market was never touched: published.
    published: controlPublished ?? true,
  }));

  const total = Number(totals?.total ?? 0);
  const unpublished = Number(totals?.unpublished ?? 0);
  const matchedCount = Number(matched?.value ?? 0);

  return {
    markets,
    page,
    limit,
    matched: matchedCount,
    pageCount: Math.max(1, Math.ceil(matchedCount / limit)),
    counts: { total, published: total - unpublished, unpublished },
  };
}

/** Distinct market categories, for the admin filter dropdown. */
export async function listMarketCategories(db: AdminDB): Promise<string[]> {
  const rows = await db
    .selectDistinct({ category: polymarketMarkets.category })
    .from(polymarketMarkets)
    .orderBy(asc(polymarketMarkets.category));
  return rows.map((r) => r.category).filter((c): c is string => !!c);
}

/**
 * Publishes or unpublishes markets in bulk. Ids that are not in
 * `polymarket_markets` are skipped and reported back, so a stale admin page
 * cannot create rows for markets that do not exist.
 */
export async function setMarketsPublished(
  db: AdminDB,
  ids: string[],
  published: boolean,
  updatedBy: string | null,
  now = new Date(),
): Promise<{ updated: string[]; missing: string[] }> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return { updated: [], missing: [] };

  const found = await db
    .select({ id: polymarketMarkets.id, question: polymarketMarkets.question })
    .from(polymarketMarkets)
    .where(inArray(polymarketMarkets.id, unique));
  const byId = new Map(found.map((m) => [m.id, m.question]));

  const updated: string[] = [];
  for (const id of unique) {
    const question = byId.get(id);
    if (question === undefined) continue;
    await upsertControl(db, {
      kind: PM_MARKET_KIND,
      itemId: id,
      published,
      label: question,
      updatedBy,
      now,
    });
    updated.push(id);
  }

  return { updated, missing: unique.filter((id) => !byId.has(id)) };
}

/** Publishes or unpublishes every market matching a category (or all of them). */
export async function setAllMarketsPublished(
  db: AdminDB,
  published: boolean,
  updatedBy: string | null,
  options: { category?: string } = {},
  now = new Date(),
): Promise<number> {
  const where =
    options.category && options.category !== "all"
      ? eq(polymarketMarkets.category, options.category)
      : undefined;
  const markets = await db
    .select({ id: polymarketMarkets.id, question: polymarketMarkets.question })
    .from(polymarketMarkets)
    .where(where);
  for (const market of markets) {
    await upsertControl(db, {
      kind: PM_MARKET_KIND,
      itemId: market.id,
      published,
      label: market.question,
      updatedBy,
      now,
    });
  }
  return markets.length;
}

async function upsertControl(
  db: AdminDB,
  row: {
    kind: ListingKind;
    itemId: string;
    published: boolean;
    label?: string | null;
    note?: string | null;
    updatedBy: string | null;
    now: Date;
  },
) {
  const set: Record<string, unknown> = {
    published: row.published,
    updatedBy: row.updatedBy,
    updatedAt: row.now,
  };
  if (row.label !== undefined) set.label = row.label;
  if (row.note !== undefined) set.note = row.note;

  await db
    .insert(listingControls)
    .values({
      id: listingId(row.kind, row.itemId),
      kind: row.kind,
      itemId: row.itemId,
      published: row.published,
      label: row.label ?? null,
      note: row.note ?? null,
      updatedBy: row.updatedBy,
      createdAt: row.now,
      updatedAt: row.now,
    })
    .onConflictDoUpdate({ target: listingControls.id, set });
}

export interface StockControl {
  symbol: string;
  published: boolean;
  label: string | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/** Every stock with a publishing decision, featured (published) first. */
export async function listStockControls(db: AdminDB): Promise<StockControl[]> {
  const rows = await db
    .select()
    .from(listingControls)
    .where(eq(listingControls.kind, STOCK_KIND))
    .orderBy(desc(listingControls.published), asc(listingControls.itemId));
  return rows.map((r) => ({
    symbol: r.itemId,
    published: r.published,
    label: r.label,
    note: r.note,
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt,
  }));
}

/** Features (published) or hides (unpublished) a stock. */
export async function upsertStockControl(
  db: AdminDB,
  input: { symbol: string; published: boolean; label?: string | null; note?: string | null },
  updatedBy: string | null,
  now = new Date(),
): Promise<StockControl> {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) throw new Error(`Invalid symbol: ${String(input.symbol)}`);
  await upsertControl(db, {
    kind: STOCK_KIND,
    itemId: symbol,
    published: input.published,
    label: input.label,
    note: input.note,
    updatedBy,
    now,
  });
  const [row] = await db
    .select()
    .from(listingControls)
    .where(eq(listingControls.id, listingId(STOCK_KIND, symbol)));
  return {
    symbol,
    published: row?.published ?? input.published,
    label: row?.label ?? null,
    note: row?.note ?? null,
    updatedBy: row?.updatedBy ?? updatedBy,
    updatedAt: row?.updatedAt ?? now,
  };
}

/** Removes a stock's publishing decision; it goes back to the default listing. */
export async function deleteStockControl(db: AdminDB, rawSymbol: string): Promise<boolean> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return false;
  const deleted = await db
    .delete(listingControls)
    .where(eq(listingControls.id, listingId(STOCK_KIND, symbol)))
    .returning({ id: listingControls.id });
  return deleted.length > 0;
}

/** The public featured-stocks list: every stock an admin published. */
export async function getFeaturedStocks(
  db: AdminDB,
): Promise<Array<{ symbol: string; label: string | null }>> {
  const rows = await db
    .select({ symbol: listingControls.itemId, label: listingControls.label })
    .from(listingControls)
    .where(and(eq(listingControls.kind, STOCK_KIND), eq(listingControls.published, true)))
    .orderBy(asc(listingControls.itemId));
  return rows;
}

/** Symbols an admin hid from the public stock lists. */
export async function getHiddenStockSymbols(db: AdminDB): Promise<Set<string>> {
  const rows = await db
    .select({ symbol: listingControls.itemId })
    .from(listingControls)
    .where(and(eq(listingControls.kind, STOCK_KIND), eq(listingControls.published, false)));
  return new Set(rows.map((r) => r.symbol));
}

/** Drops quotes whose symbol is hidden. Rows without a symbol are kept. */
export function filterHiddenQuotes<T extends { symbol?: unknown }>(
  quotes: T[] | undefined | null,
  hidden: Set<string>,
): T[] {
  if (!Array.isArray(quotes)) return [];
  if (hidden.size === 0) return quotes;
  return quotes.filter(
    (q) => typeof q?.symbol !== "string" || !hidden.has(q.symbol.toUpperCase()),
  );
}

/**
 * `getHiddenStockSymbols` for the public list routes: a failed lookup (no D1
 * binding in a script, a missing table before the migration ran) hides
 * nothing instead of failing the market data the route exists to serve.
 */
export async function getHiddenStockSymbolsSafe(db: () => AdminDB): Promise<Set<string>> {
  try {
    return await getHiddenStockSymbols(db());
  } catch (error) {
    console.warn("Could not load hidden stock symbols:", error);
    return new Set();
  }
}
