import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { isTraderSource } from "@/lib/admin/traders";
import { syncTraderSource } from "@/lib/admin/trader-sync";

/**
 * Pulls fresh leaders for one source from its upstream API into D1.
 * Body: `{ source: "polymarket" | "zulu" | "nvstly", limit?, orderBy? }`.
 */
export async function POST(req: NextRequest) {
  const guard = await assertAdmin();
  if (guard) return guard;

  const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!isTraderSource(body.source)) {
    return NextResponse.json({ error: "`source` must be polymarket, zulu or nvstly" }, { status: 400 });
  }

  try {
    const result = await syncTraderSource(body.source, {
      limit: typeof body.limit === "number" ? body.limit : undefined,
      orderBy: body.orderBy === "VOL" ? "VOL" : "PNL",
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error(`Admin ${body.source} trader sync failed:`, error);
    return NextResponse.json(
      { success: false, source: body.source, error: error instanceof Error ? error.message : "Sync failed" },
      { status: 502 },
    );
  }
}
