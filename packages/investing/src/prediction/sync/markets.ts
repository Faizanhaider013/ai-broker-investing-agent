import { firstClobTokenId } from "../utils/token-ids";
import { fetchMarkets, fetchAllMarkets } from "../api/markets";
import { saveMarkets } from "../db/markets";
import { syncPriceHistory } from "./prices";

/**
 * Syncs markets from Polymarket API to the database.
 * Upserts fresh data sorted by 24h volume (existing rows are kept).
 * Also fetches and stores price history for markets with token IDs.
 * @param limit - Maximum number of markets to sync (default: 200)
 * @param syncPriceHistoryFlag - Whether to also fetch price history (default: true)
 * @returns Object with count of synced markets and price history data points
 */
export async function syncMarkets(limit = 200, syncPriceHistoryFlag = true) {
  try {
    console.log("Starting Polymarket markets sync...");

    // Upsert only. This used to delete the whole table first, so a failed or
    // rate-limited fetch left the site with no markets at all — and anyone
    // could trigger it through `GET /api/polymarket/markets?sync=true`.
    // Ended markets are retired by `deactivateExpiredMarkets` instead.
    const markets: any = await fetchMarkets(limit, "volume24hr");
    await saveMarkets(markets);
    console.log(`Saved ${markets.length} markets`);

    let totalPricePoints = 0;

    // Fetch price history for markets with token IDs
    if (syncPriceHistoryFlag) {
      console.log("Fetching price history for markets...");
      for (const market of markets) {
        if (firstClobTokenId(market.clobTokenIds)) {
          try {
            // Fetch history for the first token (typically "Yes" outcome)
            const tokenId = firstClobTokenId(market.clobTokenIds) as string;

            // Validate token ID before fetching
            // Valid token IDs should be alphanumeric strings of reasonable length
            if (
              !tokenId ||
              typeof tokenId !== "string" ||
              tokenId.trim().length < 10 ||
              !/^[a-zA-Z0-9_-]+$/.test(tokenId)
            ) {
              console.log(
                `Skipping market ${market.id} - Invalid token ID: ${tokenId}`,
              );
              continue;
            }

            const result = await syncPriceHistory(tokenId, { interval: "1h" });
            totalPricePoints += result.pricePoints;
          } catch (error: any) {
            // Only log details for unexpected errors (not 400s which are common for invalid tokens)
            if (
              error.message?.includes("400") ||
              error.message?.includes("Invalid token")
            ) {
              console.log(`Skipping market ${market.id} - ${error.message}`);
            } else {
              console.error(
                `Error syncing price history for market ${market.id}:`,
                error.message,
              );
            }
          }
        }
      }
      console.log(
        `Saved ${totalPricePoints} price data points across all markets`,
      );
    }

    return { markets: markets.length, pricePoints: totalPricePoints };
  } catch (error: any) {
    console.error("Fatal error in syncMarkets:", error.message);
    throw error;
  }
}

/**
 * Syncs all active markets from Polymarket API to the database.
 * Upserts all available markets sorted by 24h volume (existing rows are kept).
 * Also fetches and stores price history for markets with token IDs.
 * @param maxMarkets - Maximum total number of markets to sync (default: 0 for unlimited, fetches ALL active markets)
 * @param syncPriceHistoryFlag - Whether to also fetch price history (default: true)
 * @returns Object with count of synced markets and price history data points
 */
export async function syncAllMarkets(
  maxMarkets = 0,
  syncPriceHistoryFlag = true,
) {
  try {
    console.log("Starting Polymarket all markets sync...");

    // Upsert only — see syncMarkets for why the table is no longer cleared.
    const markets: any = await fetchAllMarkets("volume24hr", maxMarkets);
    await saveMarkets(markets);
    console.log(`Saved ${markets.length} markets`);

    let totalPricePoints = 0;

    // Fetch price history for markets with token IDs
    if (syncPriceHistoryFlag) {
      console.log("Fetching price history for markets...");
      for (const market of markets) {
        if (firstClobTokenId(market.clobTokenIds)) {
          try {
            // Fetch history for the first token (typically "Yes" outcome)
            const tokenId = firstClobTokenId(market.clobTokenIds) as string;

            // Validate token ID before fetching
            // Valid token IDs should be alphanumeric strings of reasonable length
            if (
              !tokenId ||
              typeof tokenId !== "string" ||
              tokenId.trim().length < 10 ||
              !/^[a-zA-Z0-9_-]+$/.test(tokenId)
            ) {
              console.log(
                `Skipping market ${market.id} - Invalid token ID: ${tokenId}`,
              );
              continue;
            }

            const result = await syncPriceHistory(tokenId, { interval: "1h" });
            totalPricePoints += result.pricePoints;
          } catch (error: any) {
            // Only log details for unexpected errors (not 400s which are common for invalid tokens)
            if (
              error.message?.includes("400") ||
              error.message?.includes("Invalid token")
            ) {
              console.log(`Skipping market ${market.id} - ${error.message}`);
            } else {
              console.error(
                `Error syncing price history for market ${market.id}:`,
                error.message,
              );
            }
          }
        }
      }
      console.log(
        `Saved ${totalPricePoints} price data points across all markets`,
      );
    }

    return { markets: markets.length, pricePoints: totalPricePoints };
  } catch (error: any) {
    console.error("Fatal error in syncAllMarkets:", error.message);
    throw error;
  }
}
