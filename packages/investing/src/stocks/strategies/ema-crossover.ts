/**
 * Long-only EMA crossover strategy (9 / 20 with a 200 EMA trend filter).
 *
 * Adapted from the TradingView Pine Script strategy
 * "Long Only EMA Strategy (9/20 with 200 EMA Filter)" by `growbharat2005`
 * (catalogued in `../../algo-stategies/algo-strategies.json`, url
 * `fURZdvM1-Long-Only-EMA-Strategy-9-20-with-200-EMA-Filter`). The Pine rules
 * are:
 *
 *   longCondition = ta.crossover(ema9, ema20) and close > ema200
 *   exitCondition = ta.crossunder(close, ema20)   // acted on only while long
 *
 * This port extracts only the deterministic signal rules. It does not size
 * positions, place orders, hold credentials, or talk to a broker — it maps a
 * series of OHLCV bars to a series of `TradeSignal`s and nothing more.
 *
 * Signal timing vs. Pine: Pine's `strategy.entry` / `strategy.close` fill at
 * the NEXT bar's open by default. Here a signal is emitted at the CLOSE of the
 * bar on which the crossover is detected. A consumer that backtests these
 * signals should therefore fill at the following bar's open to reproduce the
 * Pine results; filling at the same bar's close would introduce look-ahead and
 * diverge from the original strategy.
 */

import type { TradeSignal } from "../../trading-agents/types";
import type { HistoricalQuote } from "../quote-cache-service";

/** Configuration for {@link evaluateEmaCrossover}. All periods are in bars. */
export interface EmaCrossoverConfig {
  /** Fast EMA length (Pine: 9). */
  shortPeriod: number;
  /** Slow EMA length and the exit reference (Pine: 20). */
  longPeriod: number;
  /** Trend-filter EMA length (Pine: 200). */
  trendPeriod: number;
  /**
   * Bars that must be observed (inclusive of the current bar) before any
   * actionable BUY/SELL is emitted; earlier bars are forced to HOLD. Defaults
   * to `trendPeriod` so the 200 EMA has seen a full window of data — see the
   * warm-up note on {@link evaluateEmaCrossover}.
   */
  warmupBars: number;
}

export const DEFAULT_EMA_CROSSOVER_CONFIG: EmaCrossoverConfig = {
  shortPeriod: 9,
  longPeriod: 20,
  trendPeriod: 200,
  warmupBars: 200,
};

/**
 * The minimal bar shape this strategy reads. Both `HistoricalQuote` (returned
 * by `getHistoricalQuotes`) and `HistoricalDataPoint` (the Yahoo wrapper shape)
 * satisfy it, so recorded data from either source can be replayed unchanged.
 */
export type EmaCrossoverBar = Pick<HistoricalQuote, "date" | "close">;

export function normalizeEmaCrossoverConfig(
  config: Partial<EmaCrossoverConfig> = {},
): EmaCrossoverConfig {
  const normalized = { ...DEFAULT_EMA_CROSSOVER_CONFIG, ...config };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (normalized.shortPeriod >= normalized.longPeriod) {
    throw new Error("shortPeriod must be shorter than longPeriod");
  }
  if (normalized.longPeriod >= normalized.trendPeriod) {
    throw new Error("longPeriod must be shorter than trendPeriod");
  }
  return normalized;
}

/**
 * Exponential moving average over `values`, matching Pine's `ta.ema`: the
 * series is seeded with the first value and smoothed with `alpha = 2/(len+1)`.
 * Kept inline (rather than pulling a dependency) so the seeding is explicit and
 * the whole strategy stays a single deterministic, dependency-free function.
 */
function ema(values: readonly number[], length: number): number[] {
  const out = new Array<number>(values.length);
  if (values.length === 0) return out;
  const alpha = 2 / (length + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
  }
  return out;
}

/** Pine `ta.crossover(a, b)`: a was at or below b, and is now strictly above. */
function crossover(a: readonly number[], b: readonly number[], i: number): boolean {
  return i >= 1 && a[i - 1] <= b[i - 1] && a[i] > b[i];
}

/** Pine `ta.crossunder(a, b)`: a was at or above b, and is now strictly below. */
function crossunder(a: readonly number[], b: readonly number[], i: number): boolean {
  return i >= 1 && a[i - 1] >= b[i - 1] && a[i] < b[i];
}

/**
 * Reject malformed bars before they reach the signal logic. Venue/scraped data
 * is untrusted, and a silent `NaN` close would otherwise propagate through the
 * EMAs and quietly suppress every signal, so fail loudly with the bad index.
 */
function validateBars(bars: readonly EmaCrossoverBar[]): void {
  if (!Array.isArray(bars)) {
    throw new Error("bars must be an array");
  }
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar || typeof bar.close !== "number" || !Number.isFinite(bar.close)) {
      throw new Error(`bars[${i}].close must be a finite number`);
    }
    if (typeof bar.date !== "string" || !bar.date.trim() || Number.isNaN(Date.parse(bar.date))) {
      throw new Error(`bars[${i}].date must be a valid date string`);
    }
  }
}

/**
 * Replay recorded bars through the long-only EMA crossover rules and return one
 * {@link TradeSignal} per input bar (same length and order as `bars`).
 *
 * Semantics, faithful to the Pine source:
 * - BUY when EMA-short crosses above EMA-long AND close is above EMA-trend, and
 *   only while flat — a second BUY is never emitted while a long is already
 *   open (Pine's default no-pyramiding `strategy.entry`).
 * - SELL when close crosses below EMA-long AND a long position is open.
 * - HOLD otherwise.
 *
 * Warm-up: the first `warmupBars` (default `trendPeriod` = 200) bars are forced
 * to HOLD so the 200 EMA has observed a full window before any trade. With
 * fewer than `warmupBars` bars the function returns all HOLD. `confidence` is 1
 * for an actionable BUY/SELL and 0 for HOLD. `timestamp` is taken from the
 * bar's own `date`, never the wall clock, so replays are deterministic.
 *
 * This is pure and offline: no network, no credentials, no order placement.
 *
 * @throws if `config` is invalid, or if any bar has a non-finite `close` or an
 * unparseable `date` — malformed data fails loudly instead of silently
 * degrading to all-HOLD.
 */
export function evaluateEmaCrossover(
  bars: readonly EmaCrossoverBar[],
  config: Partial<EmaCrossoverConfig> = {},
): TradeSignal[] {
  const { shortPeriod, longPeriod, trendPeriod, warmupBars } =
    normalizeEmaCrossoverConfig(config);
  validateBars(bars);

  const closes = bars.map((bar) => bar.close);
  const emaShort = ema(closes, shortPeriod);
  const emaLong = ema(closes, longPeriod);
  const emaTrend = ema(closes, trendPeriod);

  const signals: TradeSignal[] = [];
  let inPosition = false;

  for (let i = 0; i < bars.length; i++) {
    const timestamp = new Date(bars[i].date);
    const warm = i + 1 >= warmupBars;

    let action: TradeSignal["action"] = "HOLD";
    let reasoning: string;

    if (!warm) {
      reasoning = `Warm-up: fewer than ${warmupBars} bars observed (${i + 1})`;
    } else if (
      !inPosition &&
      crossover(emaShort, emaLong, i) &&
      closes[i] > emaTrend[i]
    ) {
      action = "BUY";
      inPosition = true;
      reasoning = `EMA${shortPeriod} crossed above EMA${longPeriod} with close above EMA${trendPeriod}`;
    } else if (inPosition && crossunder(closes, emaLong, i)) {
      action = "SELL";
      inPosition = false;
      reasoning = `Close crossed below EMA${longPeriod} while long`;
    } else if (inPosition) {
      reasoning = "Holding open long; no exit signal";
    } else {
      reasoning = "Flat; no entry signal";
    }

    signals.push({
      action,
      confidence: action === "HOLD" ? 0 : 1,
      reasoning,
      timestamp,
    });
  }

  return signals;
}
