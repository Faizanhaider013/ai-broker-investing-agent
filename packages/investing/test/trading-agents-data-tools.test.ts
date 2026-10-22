import { describe, expect, it } from "vitest";
import {
  getIndicators,
  type StockData,
} from "../src/trading-agents";

const stockData = (closes: number[]): StockData[] =>
  closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));

const sequence = (length: number): number[] =>
  Array.from({ length }, (_, index) => index + 1);

describe("getIndicators EMA", () => {
  it("returns one NaN per observation when the input is shorter than the period", async () => {
    const result = await getIndicators(stockData([1, 2, 3]), ["ema10"]);

    expect(result.ema10).toHaveLength(3);
    expect(result.ema10?.every(Number.isNaN)).toBe(true);
  });

  it("seeds the EMA with the SMA when the input exactly reaches the period", async () => {
    const result = await getIndicators(stockData(sequence(10)), ["ema10"]);

    expect(result.ema10).toHaveLength(10);
    expect(result.ema10?.slice(0, 9).every(Number.isNaN)).toBe(true);
    expect(result.ema10?.[9]).toBeCloseTo(5.5);
  });

  it("preserves the existing recurrence after the SMA seed", async () => {
    const result = await getIndicators(stockData(sequence(11)), ["ema10"]);

    expect(result.ema10).toHaveLength(11);
    expect(result.ema10?.[9]).toBeCloseTo(5.5);
    expect(result.ema10?.[10]).toBeCloseTo(6.5);
  });

  it("returns empty EMA and MACD arrays for empty input", async () => {
    const result = await getIndicators([], ["ema10", "macd"]);

    expect(result).toEqual({
      ema10: [],
      macd: [],
      macdSignal: [],
      macdHistogram: [],
    });
  });
});

describe("getIndicators MACD", () => {
  it("keeps the signal and histogram unavailable until nine MACD values exist", async () => {
    const result = await getIndicators(stockData(sequence(26)), ["macd"]);

    expect(result.macd).toHaveLength(26);
    expect(result.macd?.slice(0, 25).every(Number.isNaN)).toBe(true);
    expect(result.macd?.[25]).toBeCloseTo(7);
    expect(result.macdSignal).toHaveLength(26);
    expect(result.macdSignal?.every(Number.isNaN)).toBe(true);
    expect(result.macdHistogram).toHaveLength(26);
    expect(result.macdHistogram?.every(Number.isNaN)).toBe(true);
  });

  it("aligns the first valid signal and histogram with the 34th observation", async () => {
    const result = await getIndicators(stockData(sequence(34)), ["macd"]);

    expect(result.macd).toHaveLength(34);
    expect(result.macd?.slice(0, 25).every(Number.isNaN)).toBe(true);
    expect(result.macd?.[33]).toBeCloseTo(7);
    expect(result.macdSignal).toHaveLength(34);
    expect(result.macdSignal?.slice(0, 33).every(Number.isNaN)).toBe(true);
    expect(result.macdSignal?.[33]).toBeCloseTo(7);
    expect(result.macdHistogram).toHaveLength(34);
    expect(result.macdHistogram?.slice(0, 33).every(Number.isNaN)).toBe(true);
    expect(result.macdHistogram?.[33]).toBeCloseTo(0);
  });
});
