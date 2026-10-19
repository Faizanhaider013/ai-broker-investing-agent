import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/auth/admin";
import { clampRefillSize, refillMarkets } from "@/packages/investing/src/prediction";

/**
 * Refills the prediction-market table from Polymarket: upserts the top open
 * markets by volume and retires markets that have ended. Non-destructive —
 * publish decisions, price history and holders are kept.
 *
 * Body (all optional): `{ maxMarkets?: number, priceHistory?: boolean,
 * holders?: boolean, deactivateExpired?: boolean }`.
 */
export async function POST(req: NextRequest) {
  const guard = await assertAdmin();
  if (guard) return guard;

  const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const maxMarkets = clampRefillSize(body.maxMarkets);
  const started = Date.now();

  try {
    const result = await refillMarkets({
      maxMarkets,
      priceHistory: body.priceHistory === true,
      holders: body.holders === true,
      deactivateExpired: body.deactivateExpired !== false,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    return NextResponse.json({
      success: true,
      ...result,
      requested: maxMarkets,
      duration: `${seconds}s`,
      message: `Refilled ${result.markets} markets and retired ${result.deactivated} ended ones in ${seconds}s`,
    });
  } catch (error) {
    console.error("Admin market refill failed:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Refill failed" },
      { status: 502 },
    );
  }
}
