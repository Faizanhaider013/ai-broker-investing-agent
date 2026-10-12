import { describe, expect, it } from "vitest";
import {
  DEFAULT_BB_RSI_BREAKOUT_CONFIG,
  evaluateBbRsiBreakout,
  normalizeBbRsiBreakoutConfig,
  type BbRsiBreakoutBar,
} from "../src/stocks";

/**
 * Build bars with sequential UTC-minute timestamps from a close series. `high`
 * and `low` default to `close`; override per index to exercise the take-profit
 * limit, which is detected from high/low rather than close.
 */
const bars = (
  closes: number[],
  opts: { highs?: number[]; lows?: number[] } = {},
): BbRsiBreakoutBar[] =>
  closes.map((close, index) => ({
    date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    close,
    high: opts.highs ? opts.highs[index] : close,
    low: opts.lows ? opts.lows[index] : close,
  }));

const actions = (bs: BbRsiBreakoutBar[], config = {}) =>
  evaluateBbRsiBreakout(bs, config).map((s) => s.action);

// Small-period config so entries/exits are exercised without 30 warm-up bars.
// A lower stdev multiplier keeps band breakouts reachable at this window size
// (a single close can sit at most (n-1)/sqrt(n) std from its own window mean,
// which is < 2 for n < 6); the Pine default of 2.0 is asserted separately in
// the normalize block below. Expected signal indices below were computed by an
// independent re-implementation of the SMA / population-stdev / Wilder-RSI math.
const fast = {
  bbPeriod: 5,
  bbStdDev: 1.0,
  rsiPeriod: 3,
  longTpMult: 1.03,
  shortTpMult: 0.97,
  warmupBars: 5,
};

describe("evaluateBbRsiBreakout", () => {
  it("emits one signal per bar, in order, with the bar's own timestamp", () => {
    const input = bars([100, 99, 98, 97, 96, 90, 85, 100]);
    const signals = evaluateBbRsiBreakout(input, fast);
    expect(signals).toHaveLength(input.length);
    expect(signals[0].timestamp.toISOString()).toBe(input[0].date);
    expect(signals[7].timestamp.toISOString()).toBe(input[7].date);
  });

  it("opens a long when close breaks below the lower band with RSI < 30, then closes it at the take-profit", () => {
    // Decline drives RSI to 0 and pokes close below the lower band at bar 4
    // (close 96 < lower 96.586). Entry price 96 → long TP = 96 × 1.03 = 98.88.
    // Bar 7 rebounds to a high of 100 ≥ 98.88 → take-profit fills.
    const signals = evaluateBbRsiBreakout(bars([100, 99, 98, 97, 96, 90, 85, 100]), fast);
    expect(signals[4]).toMatchObject({ action: "BUY", confidence: 1 });
    expect(signals[4].reasoning).toContain("Long entry");
    expect(signals.slice(0, 4).every((s) => s.action === "HOLD")).toBe(true);

    expect(signals[7]).toMatchObject({ action: "SELL", confidence: 1 });
    expect(signals[7].reasoning).toContain("Close long at take-profit");
    // Held, never re-entered, between entry and the TP fill.
    expect(signals.slice(5, 7).every((s) => s.action === "HOLD")).toBe(true);
  });

  it("opens a short when close breaks above the upper band with RSI > 70, then covers at the take-profit", () => {
    // Rally drives RSI to 100 and pokes close above the upper band at bar 4
    // (close 104 > upper 103.414). Entry price 104 → short TP = 104 × 0.97 =
    // 100.88. Bar 7 dips to a low of 100 ≤ 100.88 → cover fills.
    const signals = evaluateBbRsiBreakout(bars([100, 101, 102, 103, 104, 110, 115, 100]), fast);
    expect(signals[4]).toMatchObject({ action: "SELL", confidence: 1 });
    expect(signals[4].reasoning).toContain("Short entry");
    expect(signals.slice(0, 4).every((s) => s.action === "HOLD")).toBe(true);

    expect(signals[7]).toMatchObject({ action: "BUY", confidence: 1 });
    expect(signals[7].reasoning).toContain("Cover short at take-profit");
    expect(signals.slice(5, 7).every((s) => s.action === "HOLD")).toBe(true);
  });

  it("fills the long take-profit on the bar's high, not its close", () => {
    const closes = [100, 99, 98, 97, 96, 90, 85, 82];
    // Entry at bar 4 (price 96) → TP 98.88. Bar 5 closes at 90 (below TP) but
    // its HIGH reaches 99 (≥ 98.88): the limit fills on the high.
    const withHigh = evaluateBbRsiBreakout(
      bars(closes, { highs: [100, 99, 98, 97, 96, 99, 85, 82] }),
      fast,
    );
    expect(withHigh[4].action).toBe("BUY");
    expect(withHigh[5].action).toBe("SELL");
    expect(withHigh[5].reasoning).toContain("take-profit");

    // Control: identical closes, but bar 5's high is 97 (< 98.88). With close
    // alone the result would be unchanged; because the TP reads the high, no
    // fill happens and the long is still held at bar 5.
    const noHigh = evaluateBbRsiBreakout(
      bars(closes, { highs: [100, 99, 98, 97, 96, 97, 85, 82] }),
      fast,
    );
    expect(noHigh[4].action).toBe("BUY");
    expect(noHigh[5].action).toBe("HOLD");
    expect(noHigh[6].action).toBe("HOLD");
  });

  it("fills the short take-profit on the bar's low, not its close", () => {
    const closes = [100, 101, 102, 103, 104, 110, 115, 118];
    // Entry at bar 4 (price 104) → TP 100.88. Bar 5 closes at 110 (above TP)
    // but its LOW reaches 100 (≤ 100.88): the limit fills on the low.
    const withLow = evaluateBbRsiBreakout(
      bars(closes, { lows: [100, 101, 102, 103, 104, 100, 115, 118] }),
      fast,
    );
    expect(withLow[4].action).toBe("SELL");
    expect(withLow[5].action).toBe("BUY");
    expect(withLow[5].reasoning).toContain("take-profit");
  });

  it("does not open a second position while one is already open", () => {
    // After the long entry at bar 4, close keeps falling (increasingly
    // oversold) but the position stays open and the TP is never reached, so no
    // further BUY and no SELL are emitted.
    const acts = actions(bars([100, 99, 98, 97, 96, 90, 85, 80, 78, 76]), fast);
    expect(acts[4]).toBe("BUY");
    expect(acts.filter((a) => a === "BUY")).toHaveLength(1);
    expect(acts.filter((a) => a === "SELL")).toHaveLength(0);
    expect(acts.slice(5).every((a) => a === "HOLD")).toBe(true);
  });

  it("holds on a flat series with no band breakout", () => {
    const acts = actions(bars(new Array(10).fill(50)), fast);
    expect(acts.every((a) => a === "HOLD")).toBe(true);
  });

  it("gives HOLD signals confidence 0 and actionable signals confidence 1", () => {
    const signals = evaluateBbRsiBreakout(bars([100, 99, 98, 97, 96, 90, 85, 100]), fast);
    for (const signal of signals) {
      expect(signal.confidence).toBe(signal.action === "HOLD" ? 0 : 1);
    }
  });

  it("replays identical input deterministically", () => {
    const input = bars([100, 99, 98, 97, 96, 90, 85, 100]);
    expect(evaluateBbRsiBreakout(input, fast)).toEqual(evaluateBbRsiBreakout(input, fast));
  });

  it("handles an empty series", () => {
    expect(evaluateBbRsiBreakout([], fast)).toEqual([]);
  });
});

describe("evaluateBbRsiBreakout warm-up", () => {
  it("forces HOLD during the warm-up window and labels the reason", () => {
    const signals = evaluateBbRsiBreakout(bars([100, 99, 98, 97, 96, 90, 85, 100]), fast);
    // warmupBars = 5 → indices 0..3 are warm-up; index 4 is the first evaluated bar.
    expect(signals[3].reasoning).toMatch(/^Warm-up/);
    expect(signals[4].reasoning).not.toMatch(/^Warm-up/);
    expect(signals.slice(0, 4).every((s) => s.action === "HOLD")).toBe(true);
  });

  it("requires at least `bbPeriod` (30) bars before any signal under the default config", () => {
    const signals = evaluateBbRsiBreakout(bars(new Array(30).fill(50)));
    expect(DEFAULT_BB_RSI_BREAKOUT_CONFIG.warmupBars).toBe(30);
    // 30 bars observed: index 28 is still warm-up, index 29 is the first evaluated bar.
    expect(signals[28].reasoning).toMatch(/^Warm-up/);
    expect(signals[29].reasoning).not.toMatch(/^Warm-up/);
    expect(signals.every((s) => s.action === "HOLD")).toBe(true);
  });

  it("returns all HOLD when fewer than `warmupBars` bars are supplied", () => {
    const signals = evaluateBbRsiBreakout(bars(new Array(29).fill(50)));
    expect(signals).toHaveLength(29);
    expect(signals.every((s) => s.action === "HOLD")).toBe(true);
    expect(signals.every((s) => /^Warm-up/.test(s.reasoning))).toBe(true);
  });
});

describe("evaluateBbRsiBreakout input validation", () => {
  const goodDate = new Date(Date.UTC(2026, 0, 1)).toISOString();
  const bar = (over: Partial<BbRsiBreakoutBar>): BbRsiBreakoutBar => ({
    date: goodDate,
    close: 100,
    high: 100,
    low: 100,
    ...over,
  });

  it("throws on a non-finite close, high, or low, naming the offending field and index", () => {
    expect(() => evaluateBbRsiBreakout([bar({ close: Number.NaN })], fast)).toThrow(
      "bars[0].close must be a finite number",
    );
    expect(() => evaluateBbRsiBreakout([bar({ high: Number.POSITIVE_INFINITY })], fast)).toThrow(
      "bars[0].high must be a finite number",
    );
    expect(() => evaluateBbRsiBreakout([bar({ low: Number.NaN })], fast)).toThrow(
      "bars[0].low must be a finite number",
    );
  });

  it("throws on a missing or non-numeric close", () => {
    const missing = [{ date: goodDate, high: 100, low: 100 } as unknown as BbRsiBreakoutBar];
    expect(() => evaluateBbRsiBreakout(missing, fast)).toThrow("bars[0].close must be a finite number");
  });

  it("throws on an invalid or empty date", () => {
    expect(() => evaluateBbRsiBreakout([bar({ date: "not-a-date" })], fast)).toThrow(
      "bars[0].date must be a valid date string",
    );
    expect(() => evaluateBbRsiBreakout([bar({ date: "   " })], fast)).toThrow(
      "bars[0].date must be a valid date string",
    );
  });

  it("throws when bars is not an array", () => {
    expect(() =>
      evaluateBbRsiBreakout(undefined as unknown as BbRsiBreakoutBar[], fast),
    ).toThrow("bars must be an array");
  });

  it("accepts well-formed bars", () => {
    expect(() => evaluateBbRsiBreakout(bars([100, 99, 98, 97]), fast)).not.toThrow();
  });
});

describe("normalizeBbRsiBreakoutConfig", () => {
  it("applies the Pine defaults (30 / 2.0 / 13, TP 1.03 / 0.97)", () => {
    expect(normalizeBbRsiBreakoutConfig()).toEqual({
      bbPeriod: 30,
      bbStdDev: 2.0,
      rsiPeriod: 13,
      longTpMult: 1.03,
      shortTpMult: 0.97,
      warmupBars: 30,
    });
  });

  it("rejects non-positive or non-integer periods", () => {
    expect(() => normalizeBbRsiBreakoutConfig({ bbPeriod: 0 })).toThrow("positive integer");
    expect(() => normalizeBbRsiBreakoutConfig({ rsiPeriod: 2.5 })).toThrow("positive integer");
    expect(() => normalizeBbRsiBreakoutConfig({ warmupBars: -1 })).toThrow("positive integer");
  });

  it("rejects a non-positive stdev multiplier", () => {
    expect(() => normalizeBbRsiBreakoutConfig({ bbStdDev: 0 })).toThrow("bbStdDev must be a positive number");
  });

  it("rejects take-profit multipliers that are the wrong side of 1", () => {
    expect(() => normalizeBbRsiBreakoutConfig({ longTpMult: 1 })).toThrow("longTpMult must be greater than 1");
    expect(() => normalizeBbRsiBreakoutConfig({ longTpMult: 0.9 })).toThrow("longTpMult must be greater than 1");
    expect(() => normalizeBbRsiBreakoutConfig({ shortTpMult: 1 })).toThrow("shortTpMult must be between 0 and 1");
    expect(() => normalizeBbRsiBreakoutConfig({ shortTpMult: 0 })).toThrow("shortTpMult must be between 0 and 1");
  });
});
