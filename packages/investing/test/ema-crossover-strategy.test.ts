import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMA_CROSSOVER_CONFIG,
  evaluateEmaCrossover,
  normalizeEmaCrossoverConfig,
  type EmaCrossoverBar,
} from "../src/stocks";

/** Build bars with sequential UTC-minute timestamps from a close series. */
const bars = (closes: number[]): EmaCrossoverBar[] =>
  closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    close,
  }));

const actions = (closes: number[], config = {}) =>
  evaluateEmaCrossover(bars(closes), config).map((signal) => signal.action);

// Small-period config so entry/exit/repeat logic is exercised without needing
// 200 warm-up bars. The default (200-bar) config is covered separately below.
const fast = { shortPeriod: 2, longPeriod: 4, trendPeriod: 6, warmupBars: 6 };

// A down-trend (warm-up) → up-trend (entry) → pullback (exit) path whose exact
// signal sequence is computed from the EMA formula, not snapshotted.
const DOWN_UP_DOWN = [100, 98, 96, 94, 92, 90, 93, 97, 102, 108, 115, 112, 108, 103, 99];

describe("evaluateEmaCrossover", () => {
  it("emits one signal per bar, in order", () => {
    const signals = evaluateEmaCrossover(bars(DOWN_UP_DOWN), fast);
    expect(signals).toHaveLength(DOWN_UP_DOWN.length);
    expect(signals[0].timestamp.toISOString()).toBe(bars(DOWN_UP_DOWN)[0].date);
  });

  it("enters long when EMA-short crosses above EMA-long with close above the trend EMA", () => {
    const signals = evaluateEmaCrossover(bars(DOWN_UP_DOWN), fast);
    expect(signals[7]).toMatchObject({ action: "BUY", confidence: 1 });
    expect(signals[7].reasoning).toContain("crossed above");
    // Nothing actionable before the entry bar.
    expect(signals.slice(0, 7).every((s) => s.action === "HOLD")).toBe(true);
  });

  it("exits the long when close crosses below EMA-long while a position is open", () => {
    const signals = evaluateEmaCrossover(bars(DOWN_UP_DOWN), fast);
    expect(signals[12]).toMatchObject({ action: "SELL", confidence: 1 });
    expect(signals[12].reasoning).toContain("while long");
  });

  it("does not repeat BUY while already long through a sustained up-trend", () => {
    const acts = actions(DOWN_UP_DOWN, fast);
    expect(acts.filter((a) => a === "BUY")).toHaveLength(1);
    expect(acts.filter((a) => a === "SELL")).toHaveLength(1);
    // Bars 8–11 continue rising but stay long: HOLD, never a second BUY.
    expect(acts.slice(8, 12).every((a) => a === "HOLD")).toBe(true);
  });

  it("never emits SELL when flat", () => {
    // Down-only series: a crossunder of close/EMA-long occurs, but with no open
    // position it must stay HOLD, never SELL.
    const acts = actions([100, 98, 96, 94, 92, 90, 88, 86, 84, 82], fast);
    expect(acts.includes("SELL")).toBe(false);
    expect(acts.includes("BUY")).toBe(false);
  });

  it("suppresses BUY when a bullish EMA-short/EMA-long crossover occurs below the trend EMA", () => {
    // A high plateau keeps a long-period trend EMA elevated, then a drop and a
    // rally produce a genuine EMA-short-over-EMA-long crossover at bar 13 while
    // close is still below the (elevated) trend EMA.
    const closes = [100, 100, 100, 100, 100, 100, 100, 100, 70, 48, 36, 46, 54, 60, 64, 63, 58, 52];

    // Elevated trend filter (trendPeriod 10): the crossover is blocked, no BUY.
    const filtered = actions(closes, { shortPeriod: 2, longPeriod: 4, trendPeriod: 10, warmupBars: 10 });
    expect(filtered.includes("BUY")).toBe(false);
    expect(filtered.every((a) => a === "HOLD")).toBe(true);

    // Control: identical closes and EMA-short/long, only the trend EMA tracks
    // closer (trendPeriod 5) so close is above it at the crossover. The SAME
    // crossover now yields a BUY at bar 13 — proving bar 13 is a real crossover
    // and that the trend filter alone is what suppresses it above.
    const control = actions(closes, { shortPeriod: 2, longPeriod: 4, trendPeriod: 5, warmupBars: 10 });
    expect(control[13]).toBe("BUY");
    expect(control.filter((a) => a === "BUY")).toHaveLength(1);
  });

  it("holds on a flat series with no crossovers", () => {
    const acts = actions(new Array(12).fill(50), fast);
    expect(acts.every((a) => a === "HOLD")).toBe(true);
  });

  it("forces HOLD during the warm-up window and labels the reason", () => {
    const signals = evaluateEmaCrossover(bars(DOWN_UP_DOWN), fast);
    // warmupBars = 6 → indices 0..4 are warm-up; index 5 is the first evaluated bar.
    expect(signals[4].reasoning).toMatch(/^Warm-up/);
    expect(signals[5].reasoning).not.toMatch(/^Warm-up/);
    expect(signals.slice(0, 5).every((s) => s.action === "HOLD")).toBe(true);
  });

  it("requires at least `trendPeriod` (200) bars before any signal under the default config", () => {
    const signals = evaluateEmaCrossover(bars(new Array(200).fill(50)));
    expect(DEFAULT_EMA_CROSSOVER_CONFIG.warmupBars).toBe(200);
    // 200 bars observed: index 198 is still warm-up, index 199 is the first evaluated bar.
    expect(signals[198].reasoning).toMatch(/^Warm-up/);
    expect(signals[199].reasoning).not.toMatch(/^Warm-up/);
    expect(signals.every((s) => s.action === "HOLD")).toBe(true);
  });

  it("returns all HOLD when fewer than `warmupBars` bars are supplied", () => {
    const signals = evaluateEmaCrossover(bars(new Array(199).fill(50)));
    expect(signals).toHaveLength(199);
    expect(signals.every((s) => s.action === "HOLD")).toBe(true);
    expect(signals.every((s) => /^Warm-up/.test(s.reasoning))).toBe(true);
  });

  it("gives HOLD signals confidence 0 and actionable signals confidence 1", () => {
    const signals = evaluateEmaCrossover(bars(DOWN_UP_DOWN), fast);
    for (const signal of signals) {
      expect(signal.confidence).toBe(signal.action === "HOLD" ? 0 : 1);
    }
  });

  it("replays identical input deterministically", () => {
    const input = bars(DOWN_UP_DOWN);
    expect(evaluateEmaCrossover(input, fast)).toEqual(evaluateEmaCrossover(input, fast));
  });

  it("handles an empty series", () => {
    expect(evaluateEmaCrossover([], fast)).toEqual([]);
  });
});

describe("evaluateEmaCrossover input validation", () => {
  const goodDate = new Date(Date.UTC(2026, 0, 1)).toISOString();

  it("throws on a non-finite close, naming the offending index", () => {
    const withNaN = [...bars([100, 98, 96]), { date: goodDate, close: Number.NaN }];
    expect(() => evaluateEmaCrossover(withNaN, fast)).toThrow("bars[3].close must be a finite number");
    const withInfinity = [{ date: goodDate, close: Number.POSITIVE_INFINITY }];
    expect(() => evaluateEmaCrossover(withInfinity, fast)).toThrow("bars[0].close must be a finite number");
  });

  it("throws on a missing or non-numeric close", () => {
    const missing = [{ date: goodDate } as unknown as EmaCrossoverBar];
    expect(() => evaluateEmaCrossover(missing, fast)).toThrow("bars[0].close must be a finite number");
  });

  it("throws on an invalid or empty date", () => {
    const badDate = [{ date: "not-a-date", close: 100 }];
    expect(() => evaluateEmaCrossover(badDate, fast)).toThrow("bars[0].date must be a valid date string");
    const emptyDate = [{ date: "   ", close: 100 }];
    expect(() => evaluateEmaCrossover(emptyDate, fast)).toThrow("bars[0].date must be a valid date string");
  });

  it("throws when bars is not an array", () => {
    expect(() => evaluateEmaCrossover(undefined as unknown as EmaCrossoverBar[], fast)).toThrow(
      "bars must be an array",
    );
  });

  it("accepts well-formed bars", () => {
    expect(() => evaluateEmaCrossover(bars([100, 98, 96, 94]), fast)).not.toThrow();
  });
});

describe("normalizeEmaCrossoverConfig", () => {
  it("applies the Pine defaults (9 / 20 / 200)", () => {
    expect(normalizeEmaCrossoverConfig()).toEqual({
      shortPeriod: 9,
      longPeriod: 20,
      trendPeriod: 200,
      warmupBars: 200,
    });
  });

  it("rejects non-positive or non-integer periods", () => {
    expect(() => normalizeEmaCrossoverConfig({ shortPeriod: 0 })).toThrow("positive integer");
    expect(() => normalizeEmaCrossoverConfig({ longPeriod: 2.5 })).toThrow("positive integer");
  });

  it("rejects a period ordering that is not short < long < trend", () => {
    expect(() => normalizeEmaCrossoverConfig({ shortPeriod: 20, longPeriod: 20 })).toThrow(
      "shortPeriod must be shorter than longPeriod",
    );
    expect(() => normalizeEmaCrossoverConfig({ longPeriod: 200, trendPeriod: 200 })).toThrow(
      "longPeriod must be shorter than trendPeriod",
    );
  });
});
