import { NextRequest, NextResponse } from "next/server";
import { assertAdmin, getAdminAccess } from "@/lib/auth/admin";
import { getAdminDB } from "@/lib/admin/db";
import {
  MARKET_SORTS,
  MARKET_STATUS_FILTERS,
  MAX_BULK_IDS,
  listMarketCategories,
  listMarketsForAdmin,
  setAllMarketsPublished,
  setMarketsPublished,
  type MarketSort,
  type MarketStatusFilter,
} from "@/lib/admin/listings";

function intParam(raw: string | null, fallback: number): number {
  const parsed = parseInt(raw ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Prediction markets with their publish state, for the admin markets section.
 * Filters: `q` (question/slug/id), `category`, `status`
 * (all|published|unpublished), `active=true`, `sort`, `page`, `limit`.
 */
export async function GET(req: NextRequest) {
  const guard = await assertAdmin();
  if (guard) return guard;

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") ?? "all";
  const sort = searchParams.get("sort") ?? "volume24hr";

  const db = getAdminDB();
  const [result, categories] = await Promise.all([
    listMarketsForAdmin(db, {
      q: searchParams.get("q") ?? undefined,
      category: searchParams.get("category") ?? undefined,
      status: (MARKET_STATUS_FILTERS as readonly string[]).includes(status)
        ? (status as MarketStatusFilter)
        : "all",
      sort: (MARKET_SORTS as readonly string[]).includes(sort) ? (sort as MarketSort) : "volume24hr",
      activeOnly: searchParams.get("active") === "true",
      page: Math.max(1, intParam(searchParams.get("page"), 1)),
      limit: intParam(searchParams.get("limit"), 25),
    }),
    listMarketCategories(db),
  ]);

  return NextResponse.json({ ...result, categories });
}

/**
 * Publishes or unpublishes markets. Body is either
 * `{ ids: string[], published: boolean }` (at most MAX_BULK_IDS ids) or
 * `{ all: true, published: boolean, category?: string }`.
 */
export async function PATCH(req: NextRequest) {
  const guard = await assertAdmin();
  if (guard) return guard;

  const body = (await req.json().catch(() => null)) as {
    ids?: unknown;
    published?: unknown;
    all?: unknown;
    category?: unknown;
  } | null;

  if (!body || typeof body.published !== "boolean") {
    return NextResponse.json({ error: "`published` must be a boolean" }, { status: 400 });
  }

  const { email } = await getAdminAccess();
  const db = getAdminDB();

  if (body.all === true) {
    const category = typeof body.category === "string" ? body.category : undefined;
    const updated = await setAllMarketsPublished(db, body.published, email, { category });
    return NextResponse.json({ updated, published: body.published });
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "`ids` must be a non-empty array of market ids" }, { status: 400 });
  }
  if (body.ids.length > MAX_BULK_IDS) {
    return NextResponse.json(
      { error: `At most ${MAX_BULK_IDS} markets per request` },
      { status: 400 },
    );
  }

  const result = await setMarketsPublished(db, body.ids as string[], body.published, email);
  return NextResponse.json({
    updated: result.updated.length,
    missing: result.missing,
    published: body.published,
  });
}
