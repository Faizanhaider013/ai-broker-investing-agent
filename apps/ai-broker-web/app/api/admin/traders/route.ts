import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { getAdminDB } from "@/lib/admin/db";
import { countTradersBySource, isTraderSort, isTraderSource, loadTopTraders } from "@/lib/admin/traders";

/**
 * Top traders from one copy-trading source (`source` = polymarket|zulu|nvstly,
 * default polymarket), ranked by `sort` (pnl|vol|winRate|rank), `limit` ≤ 200.
 */
export async function GET(req: NextRequest) {
  const guard = await assertAdmin();
  if (guard) return guard;

  const { searchParams } = new URL(req.url);
  const source = searchParams.get("source") ?? "polymarket";
  const sort = searchParams.get("sort") ?? "pnl";
  if (!isTraderSource(source)) {
    return NextResponse.json({ error: `Unknown source: ${source}` }, { status: 400 });
  }

  const limit = parseInt(searchParams.get("limit") ?? "", 10);
  const db = getAdminDB();
  const [traders, counts] = await Promise.all([
    loadTopTraders(db, {
      source,
      sort: isTraderSort(sort) ? sort : "pnl",
      limit: Number.isNaN(limit) ? 50 : limit,
    }),
    countTradersBySource(db),
  ]);

  return NextResponse.json({ source, traders, counts });
}
