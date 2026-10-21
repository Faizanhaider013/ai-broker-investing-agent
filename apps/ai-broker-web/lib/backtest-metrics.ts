/**
 * @fileoverview Pure backtest metric helpers, kept free of any trade-execution,
 * sizing, or risk logic so they can be unit-tested in isolation and reused by
 * backtest routes. Nothing here places orders, holds credentials, or touches a
 * broker — a metric is computed from an equity curve and nothing more.
 */

/**
 * Maximum drawdown of an equity curve, returned as a non-negative percentage
 * (e.g. `30` for a 30% decline, never the fraction `0.3`).
 *
 * Max drawdown is the largest peak-to-trough decline. Walking the curve, we
 * track the highest equity seen so far — the running peak — and, whenever
 * equity sits below that peak, measure how far it has fallen as a fraction of
 * the peak it fell from. The deepest such fall is the max drawdown. This is the
 * standard definition; the previous backtest metric instead compared the global
 * maximum to the global minimum, which reports a decline even for a curve that
 * only ever rises (its minimum is just its starting point), so a profitable
 * run showed a large phantom drawdown.
 *
 * Behaviour:
 * - A flat curve and a monotonically rising curve both return `0` — neither
 *   ever falls below its running peak.
 * - `[100, 70, 120]` returns `30`: the 100 → 70 leg is a 30% decline, and the
 *   later rise to 120 sets a new peak without adding a deeper drawdown.
 * - With several peaks and troughs, the deepest *percentage* decline wins, not
 *   the largest absolute dollar drop.
 *
 * Edge cases follow the route's prior `maxValue > 0 ? … : 0` convention and
 * stay finite — never `NaN` or `Infinity`:
 * - An empty curve returns `0` (no equity was ever observed, as for a backtest
 *   that never traded).
 * - A percentage decline is only defined once the running peak is positive, so
 *   points seen while the peak is `<= 0` contribute `0`. For the non-negative
 *   equity curves this backtest produces (cash is never spent below zero and
 *   share value is non-negative), the result lies in `[0, 100]`.
 *
 * @param equityCurve Portfolio value sampled over time, in chronological order.
 * @returns The maximum peak-to-trough decline as a percentage in `[0, …]`.
 */
export function maxDrawdownPercent(equityCurve: readonly number[]): number {
  let peak = -Infinity
  let maxDrawdown = 0

  for (const value of equityCurve) {
    if (value > peak) peak = value
    if (peak > 0 && value < peak) {
      const drawdown = ((peak - value) / peak) * 100
      if (drawdown > maxDrawdown) maxDrawdown = drawdown
    }
  }

  return maxDrawdown
}

/**
 * Per-period simple returns of an equity curve: for each consecutive pair of
 * sampled portfolio values, the fractional change `(current - previous) /
 * previous`.
 *
 * This is deliberately computed only from the equity curve itself. The return
 * of a period is the mark-to-market change in the portfolio's sampled value and
 * never reconstructs one period's value from another period's holdings — a buy
 * or sell that merely converts cash to shares (or back) at that bar's price does
 * not move total equity, so it does not create a phantom return.
 *
 * Zero-denominator guard: a return is only defined when the prior period's
 * equity is a positive, finite number. Periods whose `previous` value is zero,
 * negative, or non-finite are omitted rather than yielding `Infinity` or `NaN`
 * (for example the first step of a curve that starts at `0`). Any non-finite
 * `current` value is likewise skipped. This keeps every downstream statistic —
 * mean, standard deviation, Sharpe ratio — finite. Returns are simple (not log)
 * returns.
 *
 * @param equityCurve Portfolio value sampled once per period, in chronological
 *   order.
 * @returns One return per defined consecutive pair; `[]` for a curve with fewer
 *   than two points, or when no pair has a positive, finite prior value.
 */
export function equityCurveReturns(equityCurve: readonly number[]): number[] {
  const returns: number[] = []

  for (let i = 1; i < equityCurve.length; i++) {
    const previous = equityCurve[i - 1]
    const current = equityCurve[i]
    if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current)) {
      continue
    }
    returns.push((current - previous) / previous)
  }

  return returns
}
