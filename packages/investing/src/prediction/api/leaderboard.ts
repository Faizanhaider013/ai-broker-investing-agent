import type { PolymarketCategory } from "../constants";

export type LeaderboardTimePeriod = "all" | "1d" | "7d" | "30d";

/** Most rows the data-api leaderboard returns per request. */
export const LEADERBOARD_PAGE_LIMIT = 50;
/** Highest offset the data-api leaderboard accepts. */
export const LEADERBOARD_MAX_OFFSET = 1000;

const TIME_PERIODS: Record<string, "DAY" | "WEEK" | "MONTH" | "ALL"> = {
  all: "ALL",
  "1d": "DAY",
  "7d": "WEEK",
  "30d": "MONTH",
  day: "DAY",
  week: "WEEK",
  month: "MONTH",
};

/**
 * Builds the data-api leaderboard URL. The API's enums are upper-case
 * (`timePeriod=ALL`, `category=OVERALL`) and it rejects `limit` above 50 and
 * `offset` above 1000, so the friendlier values callers pass ("all", "Overall",
 * a limit of 100) are normalized here — sending them verbatim made every
 * leaderboard sync fail with a 400.
 */
export function buildLeaderboardUrl(
  options: {
    timePeriod?: LeaderboardTimePeriod | string;
    orderBy?: "VOL" | "PNL";
    limit?: number;
    offset?: number;
    category?: PolymarketCategory | Lowercase<PolymarketCategory> | string;
  } = {},
): URL {
  const {
    timePeriod = "all",
    orderBy = "VOL",
    limit = 20,
    offset = 0,
    category = "Overall",
  } = options;

  const period = TIME_PERIODS[String(timePeriod).toLowerCase()] ?? "ALL";
  const safeLimit = Math.min(
    LEADERBOARD_PAGE_LIMIT,
    Math.max(1, Math.floor(Number(limit) || 1)),
  );
  const safeOffset = Math.min(
    LEADERBOARD_MAX_OFFSET,
    Math.max(0, Math.floor(Number(offset) || 0)),
  );

  const url = new URL("https://data-api.polymarket.com/v1/leaderboard");
  url.searchParams.set("timePeriod", period);
  url.searchParams.set("orderBy", orderBy === "PNL" ? "PNL" : "VOL");
  url.searchParams.set("limit", String(safeLimit));
  url.searchParams.set("offset", String(safeOffset));
  url.searchParams.set("category", String(category).toUpperCase());
  return url;
}

/**
 * Fetches one page of the Polymarket leaderboard, ranked by volume or PnL.
 * @param options - Configuration options for the leaderboard query
 * @param options.timePeriod - Time period filter: "all", "1d", "7d", or "30d" (default: "all")
 * @param options.orderBy - Sort order: "VOL" for volume or "PNL" for profit/loss (default: "VOL")
 * @param options.limit - Entries to retrieve, at most 50 (default: 20)
 * @param options.offset - Entries to skip for pagination, at most 1000 (default: 0)
 * @param options.category - Category filter (default: "Overall")
 * @returns Array of leaderboard entries
 * @throws Error if the API request fails
 */
export async function fetchLeaderboard(
  options: Parameters<typeof buildLeaderboardUrl>[0] = {},
): Promise<any[]> {
  const resp = await fetch(buildLeaderboardUrl(options), {
    headers: { accept: "application/json" },
  });

  if (!resp.ok) throw new Error(`leaderboard fetch failed: ${resp.status}`);
  const data = await resp.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Fetches up to `limit` leaderboard entries, paging through the API's
 * 50-row pages until it runs dry or the offset cap is reached.
 */
export async function fetchLeaderboardPages(
  options: Omit<Parameters<typeof buildLeaderboardUrl>[0] & {}, "offset"> = {},
): Promise<any[]> {
  const total = Math.max(1, Math.floor(Number(options.limit) || 20));
  const rows: any[] = [];
  let offset = 0;

  while (rows.length < total && offset <= LEADERBOARD_MAX_OFFSET) {
    const pageSize = Math.min(LEADERBOARD_PAGE_LIMIT, total - rows.length);
    const page = await fetchLeaderboard({ ...options, limit: pageSize, offset });
    if (page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return rows.slice(0, total);
}

/**
 * Fetches top traders from Polymarket Analytics API sorted by overall gain.
 * @param limit - Maximum number of traders to retrieve (default: 50)
 * @returns Array of trader objects with performance metrics
 * @throws Error if the API request fails
 */
export async function fetchTopTraders(limit = 50) {
  const resp = await fetch(
    "https://polymarketanalytics.com/api/traders-tag-performance",
    {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        tag: "Overall",
        sortColumn: "overall_gain",
        sortDirection: "DESC",
        minPnL: -4534159.552280787,
        maxPnL: 3203232.91229432,
        minActivePositions: 0,
        maxActivePositions: 38642,
        minWinAmount: 0,
        maxWinAmount: 20316723.043360095,
        minLossAmount: -20494980.369057264,
        maxLossAmount: 0,
        minWinRate: 0,
        maxWinRate: 100,
        minCurrentValue: 0,
        maxCurrentValue: 1000000000000,
        minTotalPositions: 1,
        maxTotalPositions: 56928,
      }),
    },
  );

  if (!resp.ok) throw new Error(`leaders fetch failed: ${resp.status}`);
  const data = await resp.json();

  // Handle both array (direct) and object { data: [...] } formats
  let traders = [];
  if (Array.isArray(data)) {
    traders = data;
  } else {
    console.error("Polymarket API returned non-array:", JSON.stringify(data));
    return [];
  }

  return traders.slice(0, limit);
}

/**
 * Fetches all positions for a specific trader from Polymarket Analytics API.
 * @param traderId - The unique identifier of the trader
 * @returns Array of position objects for the trader
 * @throws Error if the API request fails
 */
export async function fetchTraderPositions(traderId: string) {
  const resp = await fetch(
    "https://polymarketanalytics.com/api/traders-positions",
    {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
      },
      body: JSON.stringify({ trader_id: traderId }),
    },
  );

  if (!resp.ok) throw new Error(`positions fetch failed: ${resp.status}`);
  return await resp.json();
}

export interface TraderProfile {
  address: string;
  userName?: string;
  profileImage?: string;
  overallGain: number;
  winRate: number;
  totalProfit: number;
  totalLoss: number;
  totalPositions: number;
  activePositions: number;
  currentValue: number;
}

/**
 * Fetches profile stats for multiple traders from Polymarket Analytics API.
 * Uses the traders-tag-performance API to get bulk trader data.
 * @param addresses - Array of trader wallet addresses
 * @returns Map of address to trader profile data
 */
export async function fetchTraderProfiles(
  addresses: string[],
): Promise<Map<string, TraderProfile>> {
  const profileMap = new Map<string, TraderProfile>();

  if (addresses.length === 0) {
    return profileMap;
  }

  try {
    // Fetch top traders which includes performance data
    const resp = await fetch(
      "https://polymarketanalytics.com/api/traders-tag-performance",
      {
        method: "POST",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          tag: "Overall",
          sortColumn: "overall_gain",
          sortDirection: "DESC",
          minPnL: -100000000,
          maxPnL: 100000000,
          minActivePositions: 0,
          maxActivePositions: 100000,
          minWinAmount: 0,
          maxWinAmount: 100000000,
          minLossAmount: -100000000,
          maxLossAmount: 0,
          minWinRate: 0,
          maxWinRate: 100,
          minCurrentValue: 0,
          maxCurrentValue: 100000000000,
          minTotalPositions: 0,
          maxTotalPositions: 100000,
        }),
      },
    );

    if (!resp.ok) {
      console.error(`Trader profiles fetch failed: ${resp.status}`);
      return profileMap;
    }

    const data = await resp.json();
    const traders = Array.isArray(data) ? data : [];

    // Create a lookup set for efficient address matching
    const addressSet = new Set(addresses.map((a) => a.toLowerCase()));

    for (const trader of traders) {
      const traderAddress =
        trader.proxy_wallet || trader.proxyWallet || trader.address || "";
      if (addressSet.has(traderAddress.toLowerCase())) {
        profileMap.set(traderAddress.toLowerCase(), {
          address: traderAddress,
          userName: trader.user_name || trader.userName,
          profileImage: trader.profile_image || trader.profileImage,
          overallGain: trader.overall_gain || trader.overallGain || 0,
          winRate: trader.win_rate || trader.winRate || 0,
          totalProfit: trader.win_amount || trader.winAmount || 0,
          totalLoss: trader.loss_amount || trader.lossAmount || 0,
          totalPositions: trader.total_positions || trader.totalPositions || 0,
          activePositions:
            trader.active_positions || trader.activePositions || 0,
          currentValue: trader.current_value || trader.currentValue || 0,
        });
      }
    }
  } catch (error) {
    console.error("Error fetching trader profiles:", error);
  }

  return profileMap;
}

/**
 * Activity types available from Polymarket Data API
 */
export type ActivityType =
  | "TRADE"
  | "SPLIT"
  | "MERGE"
  | "REDEEM"
  | "REWARD"
  | "CONVERSION"
  | "MAKER_REBATE";

/**
 * Options for fetching trader activity
 */
export interface FetchActivityOptions {
  user: string; // Trader wallet address (required)
  limit?: number; // Default: 100, Max: 500
  offset?: number; // Default: 0, Max: 10000
  market?: string[]; // Condition IDs to filter by
  type?: ActivityType[]; // Activity types to filter by
  start?: number; // Unix timestamp minimum
  end?: number; // Unix timestamp maximum
  sortBy?: "TIMESTAMP" | "TOKENS" | "CASH";
  sortDirection?: "ASC" | "DESC";
  side?: "BUY" | "SELL";
}

/**
 * Activity record from Polymarket Data API
 */
export interface TraderActivity {
  proxyWallet: string;
  timestamp: number; // Unix timestamp in seconds
  conditionId: string;
  type: ActivityType;
  size: string; // Number of tokens as string
  usdcSize: string; // USDC amount as string
  transactionHash: string;
  price?: string;
  asset?: string;
  side?: "BUY" | "SELL";
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  icon?: string;
  eventSlug?: string;
  outcome?: string;
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  profileImageOptimized?: string;
}

/**
 * Fetches on-chain activity for a specific trader from Polymarket Data API.
 * @param options - Configuration options for the activity query
 * @returns Array of activity objects for the trader
 * @throws Error if the API request fails
 */
export async function fetchTraderActivity(
  options: FetchActivityOptions,
): Promise<TraderActivity[]> {
  const {
    user,
    limit = 100,
    offset = 0,
    market,
    type,
    start,
    end,
    sortBy = "TIMESTAMP",
    sortDirection = "DESC",
    side,
  } = options;

  const url = new URL("https://data-api.polymarket.com/activity");
  url.searchParams.set("user", user);
  url.searchParams.set("limit", String(Math.min(limit, 500)));
  url.searchParams.set("offset", String(Math.min(offset, 10000)));
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortDirection", sortDirection);

  if (market && market.length > 0) {
    url.searchParams.set("market", market.join(","));
  }
  if (type && type.length > 0) {
    url.searchParams.set("type", type.join(","));
  }
  if (start !== undefined) {
    url.searchParams.set("start", String(start));
  }
  if (end !== undefined) {
    url.searchParams.set("end", String(end));
  }
  if (side) {
    url.searchParams.set("side", side);
  }

  const resp = await fetch(url, {
    headers: { accept: "application/json" },
  });

  if (!resp.ok) {
    throw new Error(`Activity fetch failed for ${user}: ${resp.status}`);
  }

  return (await resp.json()) as TraderActivity[];
}

/**
 * Fetches all activity for a trader by paginating through all pages.
 * @param user - Trader wallet address
 * @param options - Additional fetch options
 * @param onProgress - Optional callback for progress updates
 * @returns Array of all activity objects for the trader
 */
export async function fetchAllTraderActivity(
  user: string,
  options: Omit<FetchActivityOptions, "user" | "offset"> = {},
  onProgress?: (fetched: number, total: number | null) => void,
): Promise<TraderActivity[]> {
  const allActivity: TraderActivity[] = [];
  let offset = 0;
  const limit = 500; // Max per request

  while (offset < 10000) {
    // API max offset is 10000
    const activities = await fetchTraderActivity({
      ...options,
      user,
      limit,
      offset,
    });

    if (activities.length === 0) {
      break;
    }

    allActivity.push(...activities);
    onProgress?.(allActivity.length, null);

    if (activities.length < limit) {
      // No more pages
      break;
    }

    offset += limit;

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return allActivity;
}
