/**
 * Bollinger Band + RSI mean-reversion breakout strategy.
 *
 * Faithful port of the TradingView Pine Script strategy "BB + RSI Breakout
 * Strategy". The Pine rules are:
 *
 *   basis = ta.sma(close, 30)
 *   dev   = 2.0 * ta.stdev(close, 30)
 *   upper = basis + dev
 *   lower = basis - dev
 *   rsi   = ta.rsi(close, 13)
 *
 *   longCondition  = close < lower and rsi < 30   // strategy.entry("BUY",  long)
 *   shortCondition = close > upper and rsi > 70    // strategy.entry("SELL", short)
 *
 *   // Exits are limit orders tied to the entry IDs:
 *   long  take-profit = avgEntryPrice * 1.03
 *   short take-profit = avgEntryPrice * 0.97
 *   // No stop loss. Default no-pyramiding: at most one open position.
 *
 * This port extracts only the deterministic signal rules. It does not size
 * positions, place orders, hold credentials, or talk to a broker — it maps a
 * series of OHLCV bars to a series of `TradeSignal`s and nothing more. In
 * particular it is NOT an order router: the Pine take-profit is a resting limit
 * order, but {@link TradeSignal} has no field for a limit price, so a hit
 * take-profit is surfaced as a plain BUY/SELL signal whose `reasoning` states
 * the level. A backtest/execution layer owns the actual order.
 *
 * Since the strategy is bidirectional but {@link TradeSignal.action} is only
 * `BUY | SELL | HOLD` (no side / open-close discriminator), order events are
 * mapped to Pine's own fill directions and disambiguated in `reasoning`:
 *   - BUY  = open a long            (Pine strategy.entry "BUY", long)
 *   - SELL = open a short           (Pine strategy.entry "SELL", short)
 *   - SELL = close a long at its take-profit
 *   - BUY  = close a short (cover) at its take-profit
 * Read `reasoning` (or track position state yourself) to tell an entry from an
 * exit; the action alone is ambiguous.
 *
 * Signal timing vs. Pine: entries are evaluated on the CLOSE of the bar whose
 * close/RSI satisfy the entry condition — Pine's `strategy.entry` then fills at
 * the NEXT bar's open by default, so a backtest consumer should fill entries at
 * the following bar's open to reproduce the Pine results. The take-profit is a
 * resting limit: once positioned it can fill on any LATER bar whose range
 * reaches the level, so it is detected with that bar's high/low (long TP when
 * `high >= entry * longTpMult`, short TP when `low <= entry * shortTpMult`) —
 * never with close alone, which would miss intrabar fills and diverge from the
 * Pine limit order. At most one position-changing event is emitted per bar; an
 * exit and a re-entry never share a bar (a new entry is only considered once
 * flat, from the following bar).
 */

import type { TradeSignal } from "../../trading-agents/types";
import type { HistoricalQuote } from "../quote-cache-service";

/** Configuration for {@link evaluateBbRsiBreakout}. Periods are in bars. */
export interface BbRsiBreakoutConfig {
  /** Bollinger Band SMA / stdev length (Pine: 30). */
  bbPeriod: number;
  /** Bollinger Band standard-deviation multiplier (Pine: 2.0). */
  bbStdDev: number;
  /** RSI length (Pine: 13). */
  rsiPeriod: number;
  /** Long take-profit multiplier applied to entry price (Pine: 1.03). */
  longTpMult: number;
  /** Short take-profit multiplier applied to entry price (Pine: 0.97). */
  shortTpMult: number;
  /**
   * Bars that must be observed (inclusive of the current bar) before any
   * actionable signal is emitted; earlier bars are forced to HOLD. Defaults to
   * `bbPeriod` so the Bollinger window — the longest lookback, longer than the
   * RSI window — has seen a full span of data before any trade.
   */
  warmupBars: number;
}

export const DEFAULT_BB_RSI_BREAKOUT_CONFIG: BbRsiBreakoutConfig = {
  bbPeriod: 30,
  bbStdDev: 2.0,
  rsiPeriod: 13,
  longTpMult: 1.03,
  shortTpMult: 0.97,
  warmupBars: 30,
};

/**
 * The minimal bar shape this strategy reads. `HistoricalQuote` (returned by
 * `getHistoricalQuotes`) satisfies it, so recorded data can be replayed
 * unchanged. Unlike the close-only EMA strategy, the take-profit is a limit
 * order, so `high` and `low` are required to detect intrabar TP fills.
 */
export type BbRsiBreakoutBar = Pick<HistoricalQuote, "date" | "high" | "low" | "close">;

export function normalizeBbRsiBreakoutConfig(
  config: Partial<BbRsiBreakoutConfig> = {},
): BbRsiBreakoutConfig {
  const normalized = { ...DEFAULT_BB_RSI_BREAKOUT_CONFIG, ...config };

  for (const name of ["bbPeriod", "rsiPeriod", "warmupBars"] as const) {
    const value = normalized[name];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (!Number.isFinite(normalized.bbStdDev) || normalized.bbStdDev <= 0) {
    throw new Error("bbStdDev must be a positive number");
  }
  if (!Number.isFinite(normalized.longTpMult) || normalized.longTpMult <= 1) {
    throw new Error("longTpMult must be greater than 1");
  }
  if (!Number.isFinite(normalized.shortTpMult) || normalized.shortTpMult <= 0 || normalized.shortTpMult >= 1) {
    throw new Error("shortTpMult must be between 0 and 1 (exclusive)");
  }
  return normalized;
}

/**
 * Simple moving average over `values`, matching Pine's `ta.sma(src, len)`:
 * the mean of the trailing `length`-bar window, `NaN` until a full window
 * exists. Kept inline so the whole strategy stays a single deterministic,
 * dependency-free function.
 */
function sma(values: readonly number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

/**
 * Population (biased) standard deviation over the trailing `length`-bar window,
 * matching Pine's `ta.stdev(src, len)` whose default `biased = true` divides by
 * `N`, not `N - 1`. `NaN` until a full window exists.
 */
function stdev(values: readonly number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  for (let i = length - 1; i < values.length; i++) {
    let mean = 0;
    for (let j = i - length + 1; j <= i; j++) mean += values[j];
    mean /= length;
    let variance = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const d = values[j] - mean;
      variance += d * d;
    }
    variance /= length;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

/**
 * Relative Strength Index, matching Pine's `ta.rsi(src, len)`. Pine computes it
 * from Wilder's moving average (`ta.rma`): the average gain and loss are seeded
 * with the simple mean of the first `len` price changes and then smoothed with
 * `avg = (prevAvg * (len - 1) + current) / len`. This is NOT the plain rolling
 * mean used elsewhere in the repo — that would give different (and non-Pine)
 * values — so the Wilder smoothing is implemented inline. The first `len` bars
 * are `NaN`; the first RSI value lands at index `len`.
 */
function rsi(values: readonly number[], length: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= length) return out;

  const rsiFrom = (avgGain: number, avgLoss: number): number => {
    if (avgLoss === 0) return 100;
    if (avgGain === 0) return 0;
    return 100 - 100 / (1 + avgGain / avgLoss);
  };

  // Seed: simple mean of the first `length` changes (indices 1..length).
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= length; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / length;
  let avgLoss = lossSum / length;
  out[length] = rsiFrom(avgGain, avgLoss);

  for (let i = length + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

/**
 * Reject malformed bars before they reach the signal logic. Venue/scraped data
 * is untrusted, and a silent `NaN` price would otherwise propagate through the
 * bands and RSI and quietly suppress every signal, so fail loudly with the bad
 * index. `high`, `low` and `close` are all required because the take-profit is
 * detected from the bar's high/low.
 */
function validateBars(bars: readonly BbRsiBreakoutBar[]): void {
  if (!Array.isArray(bars)) {
    throw new Error("bars must be an array");
  }
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    for (const field of ["close", "high", "low"] as const) {
      if (!bar || typeof bar[field] !== "number" || !Number.isFinite(bar[field])) {
        throw new Error(`bars[${i}].${field} must be a finite number`);
      }
    }
    if (typeof bar.date !== "string" || !bar.date.trim() || Number.isNaN(Date.parse(bar.date))) {
      throw new Error(`bars[${i}].date must be a valid date string`);
    }
  }
}

/**
 * Replay recorded bars through the BB + RSI breakout rules and return one
 * {@link TradeSignal} per input bar (same length and order as `bars`).
 *
 * Semantics, faithful to the Pine source:
 * - BUY (open long) when `close < lowerBand && rsi < rsiOversold` while flat.
 * - SELL (open short) when `close > upperBand && rsi > rsiOverbought` while flat.
 * - SELL (close long) once long and a bar's `high >= entryPrice * longTpMult`.
 * - BUY (cover short) once short and a bar's `low <= entryPrice * shortTpMult`.
 * - HOLD otherwise. No stop loss; no pyramiding — only one open position, so
 *   the "average entry price" of the Pine source equals the single entry price.
 *
 * Warm-up: the first `warmupBars` (default `bbPeriod` = 30) bars are forced to
 * HOLD so the Bollinger window has observed a full span before any trade. With
 * fewer than `warmupBars` bars the function returns all HOLD. `confidence` is 1
 * for an actionable BUY/SELL and 0 for HOLD. `timestamp` is taken from the
 * bar's own `date`, never the wall clock, so replays are deterministic.
 *
 * The RSI oversold / overbought thresholds (30 / 70) are the Pine constants and
 * are intentionally not configurable here — changing them would change the
 * strategy, not merely tune it.
 *
 * This is pure and offline: no network, no credentials, no order placement. The
 * take-profit is reported as a BUY/SELL signal because {@link TradeSignal}
 * cannot carry a limit price; the consumer places the actual order.
 *
 * @throws if `config` is invalid, or if any bar has a non-finite
 * `close`/`high`/`low` or an unparseable `date` — malformed data fails loudly
 * instead of silently degrading to all-HOLD.
 */
export function evaluateBbRsiBreakout(
  bars: readonly BbRsiBreakoutBar[],
  config: Partial<BbRsiBreakoutConfig> = {},
): TradeSignal[] {
  const { bbPeriod, bbStdDev, rsiPeriod, longTpMult, shortTpMult, warmupBars } =
    normalizeBbRsiBreakoutConfig(config);
  validateBars(bars);

  const RSI_OVERSOLD = 30;
  const RSI_OVERBOUGHT = 70;

  const closes = bars.map((bar) => bar.close);
  const basis = sma(closes, bbPeriod);
  const sd = stdev(closes, bbPeriod);
  const rsiValues = rsi(closes, rsiPeriod);

  const signals: TradeSignal[] = [];
  let position: "none" | "long" | "short" = "none";
  let entryPrice = 0;

  for (let i = 0; i < bars.length; i++) {
    const timestamp = new Date(bars[i].date);
    const warm = i + 1 >= warmupBars;

    const close = closes[i];
    const dev = bbStdDev * sd[i];
    const upper = basis[i] + dev;
    const lower = basis[i] - dev;
    const rsiNow = rsiValues[i];

    let action: TradeSignal["action"] = "HOLD";
    let reasoning: string;

    if (!warm) {
      reasoning = `Warm-up: fewer than ${warmupBars} bars observed (${i + 1})`;
    } else if (position === "long") {
      const target = entryPrice * longTpMult;
      if (bars[i].high >= target) {
        action = "SELL";
        position = "none";
        reasoning = `Close long at take-profit: high ${bars[i].high} reached entry ${entryPrice} × ${longTpMult} = ${target}`;
      } else {
        reasoning = `Holding long; take-profit ${target} not reached (high ${bars[i].high})`;
      }
    } else if (position === "short") {
      const target = entryPrice * shortTpMult;
      if (bars[i].low <= target) {
        action = "BUY";
        position = "none";
        reasoning = `Cover short at take-profit: low ${bars[i].low} reached entry ${entryPrice} × ${shortTpMult} = ${target}`;
      } else {
        reasoning = `Holding short; take-profit ${target} not reached (low ${bars[i].low})`;
      }
    } else if (close < lower && rsiNow < RSI_OVERSOLD) {
      action = "BUY";
      position = "long";
      entryPrice = close;
      reasoning = `Long entry: close ${close} below lower band ${lower} with RSI ${rsiNow} < ${RSI_OVERSOLD}`;
    } else if (close > upper && rsiNow > RSI_OVERBOUGHT) {
      action = "SELL";
      position = "short";
      entryPrice = close;
      reasoning = `Short entry: close ${close} above upper band ${upper} with RSI ${rsiNow} > ${RSI_OVERBOUGHT}`;
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
