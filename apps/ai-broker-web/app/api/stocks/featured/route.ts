import { NextResponse } from "next/server";
import { getAdminDB } from "@/lib/admin/db";
import { getFeaturedStocks } from "@/lib/admin/listings";

/**
 * The stocks an admin published to the featured list. Public.
 *
 * A failed lookup (no D1 binding, `listing_controls` missing because the
 * migration has not run) serves an empty list: featuring is optional, and the
 * scanner already hides the tab when nothing is featured.
 */
export async function GET() {
  try {
    const stocks = await getFeaturedStocks(getAdminDB());
    return NextResponse.json({ success: true, count: stocks.length, data: stocks });
  } catch (error) {
    console.warn("Could not load featured stocks:", error);
    return NextResponse.json({ success: true, count: 0, data: [] });
  }
}
