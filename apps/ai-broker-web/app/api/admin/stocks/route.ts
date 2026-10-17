import { NextRequest, NextResponse } from "next/server";
import { assertAdmin, getAdminAccess } from "@/lib/auth/admin";
import { getAdminDB } from "@/lib/admin/db";
import {
  deleteStockControl,
  listStockControls,
  normalizeSymbol,
  upsertStockControl,
} from "@/lib/admin/listings";

/** Every stock with a publishing decision: featured (published) and hidden. */
export async function GET() {
  const guard = await assertAdmin();
  if (guard) return guard;

  const stocks = await listStockControls(getAdminDB());
  return NextResponse.json({
    stocks,
    counts: {
      featured: stocks.filter((s) => s.published).length,
      hidden: stocks.filter((s) => !s.published).length,
    },
  });
}

/**
 * Features or hides stocks. Body: `{ symbol: string, published: boolean,
 * label?: string, note?: string }`, or `{ symbols: string[], published }` to
 * apply one decision to several tickers at once.
 */
export async function POST(req: NextRequest) {
  const guard = await assertAdmin();
  if (guard) return guard;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.published !== "boolean") {
    return NextResponse.json({ error: "`published` must be a boolean" }, { status: 400 });
  }

  const rawSymbols = Array.isArray(body.symbols) ? body.symbols : [body.symbol];
  if (rawSymbols.length === 0 || rawSymbols.length > 50) {
    return NextResponse.json({ error: "Send between 1 and 50 symbols" }, { status: 400 });
  }
  const symbols = rawSymbols.map(normalizeSymbol);
  const invalid = rawSymbols.filter((_, i) => symbols[i] === null);
  if (invalid.length > 0) {
    return NextResponse.json(
      { error: `Invalid symbol: ${invalid.map(String).join(", ")}` },
      { status: 400 },
    );
  }

  const label = typeof body.label === "string" ? body.label.trim().slice(0, 120) || null : undefined;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : undefined;
  const { email } = await getAdminAccess();
  const db = getAdminDB();

  const saved = [];
  for (const symbol of new Set(symbols as string[])) {
    saved.push(
      await upsertStockControl(
        db,
        // A label or note only makes sense for a single symbol.
        { symbol, published: body.published, ...(symbols.length === 1 ? { label, note } : {}) },
        email,
      ),
    );
  }
  return NextResponse.json({ stocks: saved });
}

/** Clears a stock's decision (`?symbol=`), returning it to the default listing. */
export async function DELETE(req: NextRequest) {
  const guard = await assertAdmin();
  if (guard) return guard;

  const symbol = normalizeSymbol(new URL(req.url).searchParams.get("symbol"));
  if (!symbol) {
    return NextResponse.json({ error: "A valid `symbol` is required" }, { status: 400 });
  }
  const deleted = await deleteStockControl(getAdminDB(), symbol);
  if (!deleted) {
    return NextResponse.json({ error: `${symbol} has no publishing decision` }, { status: 404 });
  }
  return NextResponse.json({ deleted: symbol });
}
