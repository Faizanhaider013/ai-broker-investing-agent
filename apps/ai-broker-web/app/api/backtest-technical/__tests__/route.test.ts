import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStrategies } = vi.hoisted(() => {
  const strategy = (name: string, actions: number[]) => ({
    name,
    strategy: vi.fn(() => actions),
  });

  return {
    mockStrategies: [
      strategy("Buy Hold", [1, 0, -1]),
      strategy("MACD Strategy", [0, 1, -1]),
      strategy("Bollinger Bands", [1, -1, 0]),
    ],
  };
});

vi.mock("indicatorts", () => ({
  STRATEGY_INFOS: mockStrategies,
  backtest: vi.fn((_asset, strategies) =>
    strategies.map((info: unknown) => ({ info })),
  ),
}));

vi.mock("@/packages/investing/src/stocks/yahoo-finance-wrapper", () => ({
  yahooFinance: {
    getHistorical: vi.fn(),
  },
}));

import { backtest } from "indicatorts";
import { yahooFinance } from "@/packages/investing/src/stocks/yahoo-finance-wrapper";
import { POST } from "../route";

const mockBacktest = backtest as unknown as ReturnType<typeof vi.fn>;
const mockGetHistorical = yahooFinance.getHistorical as unknown as ReturnType<
  typeof vi.fn
>;

const prices = [
  { date: "2024-01-02", open: 10, high: 11, low: 9, close: 10, volume: 100 },
  { date: "2024-01-03", open: 11, high: 12, low: 10, close: 11, volume: 110 },
  { date: "2024-01-04", open: 12, high: 13, low: 11, close: 12, volume: 120 },
];

const request = (strategyIds: string[]) =>
  new Request("http://localhost/api/backtest-technical", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbol: "AAPL",
      startDate: "2024-01-01",
      endDate: "2024-01-05",
      strategyIds,
    }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockGetHistorical.mockResolvedValue({ success: true, data: prices });
});

describe("POST /api/backtest-technical strategy selection", () => {
  it("maps selected short IDs to exact library strategy names", async () => {
    const response = await POST(request(["macd", "bollinger-bands"]) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockBacktest.mock.calls[0][1]).toEqual([
      mockStrategies[1],
      mockStrategies[2],
    ]);
    expect(
      body.results
        .map((result: { strategyId: string }) => result.strategyId)
        .sort(),
    ).toEqual(["bollinger-bands", "macd"]);
  });

  it("ignores unknown catalog IDs without changing selection behavior", async () => {
    const response = await POST(request(["tradingview-id", "macd"]) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockBacktest.mock.calls[0][1]).toEqual([mockStrategies[1]]);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      strategyId: "macd",
      strategyName: "MACD Strategy",
    });
  });

  it("runs all registered library strategies when no IDs are supplied", async () => {
    const response = await POST(request([]) as never);

    expect(response.status).toBe(200);
    expect(mockBacktest.mock.calls[0][1]).toEqual(mockStrategies);
  });
});

describe("POST /api/backtest-technical metrics", () => {
  const bar = (date: string, close: number) => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  });

  // Run a single strategy ("macd" -> mockStrategies[1]) with an explicit action
  // series and price path so the resulting metrics are fully determined.
  const runMetrics = async (
    actions: number[],
    closes: number[],
    initialCapital: number,
  ) => {
    mockStrategies[1].strategy.mockReturnValueOnce(actions);
    mockGetHistorical.mockResolvedValueOnce({
      success: true,
      data: closes.map((close, i) =>
        bar(`2024-02-${String(i + 1).padStart(2, "0")}`, close),
      ),
    });

    const response = await POST(
      new Request("http://localhost/api/backtest-technical", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: "AAPL",
          startDate: "2024-02-01",
          endDate: "2024-02-28",
          initialCapital,
          strategyIds: ["macd"],
        }),
      }) as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results).toHaveLength(1);
    return body.results[0];
  };

  it("derives a positive Sharpe from the mark-to-market equity curve on a winning run", async () => {
    // Flat cash 900, buy at 100 on bar 1 (still 900), mark to 1080, sell at 120.
    // Equity curve -> per-bar returns [0, 0.2, 0]; the earlier buggy code valued
    // the just-bought shares at the prior bar's price and produced a phantom
    // return on the entry bar (Sharpe ~20 instead of ~11.22).
    const result = await runMetrics([0, 1, 0, -1], [90, 100, 120, 120], 900);

    expect(result.maxDrawdown).toBe(0);
    expect(result.totalReturnPercent).toBeCloseTo(20, 10);
    expect(result.winRate).toBe(100);
    expect(result.sharpeRatio).toBeCloseTo(11.22497, 2);
    // Guards the fix: not the phantom-return value, nor the 2-return sqrt(252)
    // artifact (~15.87) the old series could collapse to.
    expect(result.sharpeRatio).toBeLessThan(14);
  });

  it("derives a negative Sharpe and real drawdown on a losing buy-and-hold run", async () => {
    // Buy at 100 and hold while price falls to 85 (forced close at the end).
    // Equity curve [1000, 1000, 900, 850] -> returns [-0.1, -0.0556].
    const result = await runMetrics([1, 0, 0], [100, 90, 85], 1000);

    expect(result.totalReturnPercent).toBeCloseTo(-15, 10);
    expect(result.maxDrawdown).toBeCloseTo(15, 10);
    expect(result.sharpeRatio).toBeLessThan(0);
    expect(result.sharpeRatio).toBeCloseTo(-55.5578, 1);
  });

  it("leaves Sharpe undefined when there is no return variation", async () => {
    // A single defined return (buy then immediately sell) has zero variance, so
    // an annualized Sharpe is not defined; max drawdown is still reported.
    const result = await runMetrics([1, -1], [100, 80], 1000);

    expect(result.sharpeRatio).toBeUndefined();
    expect(result.maxDrawdown).toBeCloseTo(20, 10);
    expect(result.totalReturnPercent).toBeCloseTo(-20, 10);
  });
});
