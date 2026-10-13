import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inserts = vi.hoisted(() => [] as Array<{ values: any; set: any }>);

vi.mock("../src/db", () => ({
  db: {
    insert: () => {
      const entry: { values: any; set: any } = { values: null, set: null };
      return {
        values(values: any) {
          entry.values = values;
          return {
            onConflictDoUpdate({ set }: { set: any }) {
              entry.set = set;
              inserts.push(entry);
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

import {
  fetchZuluTraders,
  normalizeZuluTrader,
  saveZuluTraders,
  syncZuluTraders,
  MAX_ZULU_SYNC,
} from "../src/leaders/zulu";

/** A top-traders list element: timeframe and currency stats nested in overallStats. */
function listTrader(providerId: number, overrides: Record<string, any> = {}) {
  return {
    trader: {
      providerId,
      profile: {
        name: `Trader ${providerId}`,
        countryIsoCode: "IT",
        countryName: "Italy",
        brokerName: "Other brokers",
        leverage: 500,
        demo: false,
        pageVisits: 10,
        registrationDate: 1756969780000,
      },
      overallStats: {
        balance: 40777.3,
        followers: 632,
        roiAnnualized: -311.7,
        roiProfit: 50.21,
        zuluRank: 15,
        overallDrawDownInMoney: 1778.08,
        overallDrawDownPercent: 29.36,
        providerCurrencies: "USD/JPY,EUR/USD",
        lastOpenTradeDate: 1789152338000,
        currencyStats: [{ currencyName: "USD/JPY", totalCurrencyCount: 3649 }],
        timeframeStats: {
          "180": { winTrades: 98.4, trades: 3649, maxDrawDownPercent: 12.5, avgTradeSeconds: 61.6 },
        },
      },
      badges: { ea: true },
      ...overrides,
    },
  };
}

beforeEach(() => {
  inserts.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalizeZuluTrader", () => {
  const now = new Date("2026-10-13T00:00:00Z");

  it("maps a top-traders list element", () => {
    const n = normalizeZuluTrader(listTrader(430525), now)!;
    expect(n.row).toMatchObject({
      providerId: 430525,
      name: "Trader 430525",
      roiProfit: 50.21,
      zuluRank: 15,
      maxDrawdown: 1778.08,
      maxDrawdownPercent: 12.5,
      winRate: 98.4,
      totalTrades: 3649,
      avgTradeSeconds: 62,
      isEa: 1,
      demo: 0,
      updatedAt: now,
    });
    expect(n.row.registrationDate).toEqual(new Date(1756969780000));
    // Currency stats live under overallStats in the list shape.
    expect(n.currencyStats).toHaveLength(1);
  });

  it("maps a detail trader.stats object, preferring the 180-day timeframe over 1-day", () => {
    const n = normalizeZuluTrader(
      {
        providerId: 7,
        profile: { name: "Detail" },
        overallStats: { overallDrawDownMoney: 99, zuluRank: 3 },
        timeframeStats: {
          "1": { winTrades: 0, trades: 1 },
          "180": { winTrades: 71, trades: 300 },
        },
        currencyStats: [{ currencyName: "EUR/USD" }],
        badges: { isEa: true },
      },
      now,
    )!;
    expect(n.row).toMatchObject({ providerId: 7, maxDrawdown: 99, winRate: 71, totalTrades: 300, isEa: 1 });
    expect(n.currencyStats).toEqual([{ currencyName: "EUR/USD" }]);
  });

  it("returns null for an entry without a provider id or profile", () => {
    expect(normalizeZuluTrader({ trader: { profile: { name: "x" } } })).toBeNull();
    expect(normalizeZuluTrader({ trader: { providerId: 1 } })).toBeNull();
    expect(normalizeZuluTrader(null)).toBeNull();
  });

  it("zeroes non-numeric stats instead of storing NaN", () => {
    const n = normalizeZuluTrader(listTrader(1, { overallStats: { balance: "n/a", roiProfit: NaN } }))!;
    expect(n.row.balance).toBe(0);
    expect(n.row.roiProfit).toBe(0);
    expect(n.row.winRate).toBe(0);
  });
});

describe("saveZuluTraders", () => {
  it("upserts valid traders, skips malformed ones and never writes providerId in the update set", async () => {
    const saved = await saveZuluTraders([listTrader(1), { trader: {} }, listTrader(2)], { currencyStats: false });
    expect(saved).toBe(2);
    const traderRows = inserts.filter((i) => "roiProfit" in i.values);
    expect(traderRows.map((i) => i.values.providerId)).toEqual([1, 2]);
    expect(traderRows[0].set).not.toHaveProperty("providerId");
    // Currency stats were turned off.
    expect(inserts).toHaveLength(2);
  });

  it("saves currency stats by default", async () => {
    await saveZuluTraders([listTrader(1)]);
    expect(inserts).toHaveLength(2);
    expect(inserts[1].values).toMatchObject({ id: "1-USD/JPY", providerId: 1, totalCount: 3649 });
  });
});

describe("fetchZuluTraders", () => {
  it("returns the result array and sends browser-like headers", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ result: [listTrader(1)] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const traders = await fetchZuluTraders();
    expect(traders).toHaveLength(1);
    const init = (fetchMock.mock.calls[0] as any[])[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toMatch(/Mozilla/);
    expect(headers).not.toHaveProperty("sec-fetch-site");
  });

  it("reports the HTTP status and a body snippet on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Access denied", { status: 403 })));
    await expect(fetchZuluTraders()).rejects.toThrow(/HTTP 403 — Access denied/);
  });

  it("rejects an HTML bot-check page instead of saving nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Just a moment...</html>", { status: 200 })));
    await expect(fetchZuluTraders()).rejects.toThrow(/non-JSON/);
  });

  it("rejects a JSON body without a result array", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 200 })));
    await expect(fetchZuluTraders()).rejects.toThrow(/unexpected shape/);
  });
});

describe("syncZuluTraders", () => {
  it("caps how many traders it writes", async () => {
    const many = Array.from({ length: MAX_ZULU_SYNC + 50 }, (_, i) => listTrader(i + 1));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: many }), { status: 200 })));
    const result = await syncZuluTraders({ limit: 10_000 });
    expect(result).toEqual({ traders: MAX_ZULU_SYNC, fetched: MAX_ZULU_SYNC + 50 });
    expect(inserts).toHaveLength(MAX_ZULU_SYNC);
  });

  it("honours a smaller limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) => listTrader(i + 1));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: many }), { status: 200 })));
    expect((await syncZuluTraders({ limit: 5 })).traders).toBe(5);
  });

  it("fails loudly when every returned trader is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ result: [{}, {}] }), { status: 200 })));
    await expect(syncZuluTraders()).rejects.toThrow(/none had a provider id/);
  });
});
