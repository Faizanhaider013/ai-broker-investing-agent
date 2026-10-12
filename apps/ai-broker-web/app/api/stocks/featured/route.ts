import { NextResponse } from "next/server";
import { getAdminDB } from "@/lib/admin/db";
import { getFeaturedStocks } from "@/lib/admin/listings";

/** The stocks an admin published to the featured list. Public. */
export async function GET() {
  try {
    const stocks = await getFeaturedStocks(getAdminDB());
    return NextResponse.json({ success: true, count: stocks.length, data: stocks });
  } catch (error) {
    console.error("Featured stocks fetch failed:", error);
    return NextResponse.json(
      { success: false, error: "Failed to load featured stocks", data: [] },
      { status: 500 },
    );
  }
}
