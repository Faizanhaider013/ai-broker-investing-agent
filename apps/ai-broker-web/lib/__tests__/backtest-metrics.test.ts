import { describe, it, expect } from 'vitest'
import { equityCurveReturns, maxDrawdownPercent } from '../backtest-metrics'

describe('maxDrawdownPercent', () => {
  it('returns 0 for a flat curve', () => {
    expect(maxDrawdownPercent([100, 100, 100])).toBe(0)
  })

  it('returns 0 for a monotonically rising curve', () => {
    expect(maxDrawdownPercent([100, 110, 125, 200])).toBe(0)
  })

  it('computes a single peak-to-trough decline as a percentage', () => {
    // 100 -> 70 is a 30% decline; the later rise to 120 sets a new peak.
    expect(maxDrawdownPercent([100, 70, 120])).toBeCloseTo(30, 10)
  })

  it('selects the deepest percentage decline across multiple peaks and troughs', () => {
    // Legs: 100->50 (50%), new peak 200, 200->140 (30%). Deepest is 50%.
    expect(maxDrawdownPercent([100, 50, 200, 140])).toBeCloseTo(50, 10)
  })

  it('measures drawdown from the running peak, not the global maximum', () => {
    // Global max is 200 and global min is 90, but the trough at 90 follows a
    // peak of 120, so the deepest decline is 120->90 = 25%, not (200-90)/200.
    expect(maxDrawdownPercent([100, 120, 90, 200, 180])).toBeCloseTo(25, 10)
  })

  it('ranks by percentage decline, not absolute dollar drop', () => {
    // 100->80 is a 20 dollar / 20% drop; 300->150 is a 150 dollar / 50% drop.
    expect(maxDrawdownPercent([100, 80, 300, 150])).toBeCloseTo(50, 10)
  })

  it('reports a full 100% drawdown when equity falls to zero from a peak', () => {
    expect(maxDrawdownPercent([100, 0])).toBe(100)
  })

  it('returns a number, never NaN or Infinity, for degenerate inputs', () => {
    // Empty curve: no equity observed.
    expect(maxDrawdownPercent([])).toBe(0)
    // Single point: nothing to decline from.
    expect(maxDrawdownPercent([100])).toBe(0)
    // Non-positive peaks are skipped until a positive peak exists.
    const nonPositive = maxDrawdownPercent([-10, -20, -5])
    expect(Number.isFinite(nonPositive)).toBe(true)
    expect(nonPositive).toBe(0)
  })
})

describe('equityCurveReturns', () => {
  it('computes consecutive fractional changes for a rising curve', () => {
    const returns = equityCurveReturns([100, 110, 121])
    expect(returns).toHaveLength(2)
    expect(returns[0]).toBeCloseTo(0.1, 10)
    expect(returns[1]).toBeCloseTo(0.1, 10)
  })

  it('computes negative returns for a falling curve', () => {
    const returns = equityCurveReturns([100, 90, 81])
    expect(returns).toHaveLength(2)
    expect(returns[0]).toBeCloseTo(-0.1, 10)
    expect(returns[1]).toBeCloseTo(-0.1, 10)
  })

  it('tracks a buy-and-hold mark-to-market series', () => {
    // 10 shares held from $100 through $110 then $120 (capital 1000).
    const returns = equityCurveReturns([1000, 1100, 1200])
    expect(returns).toHaveLength(2)
    expect(returns[0]).toBeCloseTo(0.1, 10)
    expect(returns[1]).toBeCloseTo(1200 / 1100 - 1, 10)
  })

  it('does not fabricate a return when a trade leaves total equity unchanged', () => {
    // A bar that only converts cash to shares (or back) at that bar's price does
    // not move total equity, so its period return is exactly 0 — not a phantom
    // move reconstructed from the new holdings at the prior bar's price.
    const returns = equityCurveReturns([1000, 1000, 1200])
    expect(returns).toHaveLength(2)
    expect(returns[0]).toBe(0)
    expect(returns[1]).toBeCloseTo(0.2, 10)
  })

  it('reflects the real move across both a buy bar and a later sell bar', () => {
    // Equity: flat cash 900 -> buy at 100 (still 900) -> mark to 1080 -> sell at
    // 120 (still 1080). Only the hold leg earned anything: [0, 0.2, 0].
    const returns = equityCurveReturns([900, 900, 1080, 1080])
    expect(returns).toHaveLength(3)
    expect(returns[0]).toBeCloseTo(0, 10)
    expect(returns[1]).toBeCloseTo(0.2, 10)
    expect(returns[2]).toBeCloseTo(0, 10)
  })

  it('skips the undefined first period when starting equity is zero', () => {
    // previous = 0 has no defined return; the next period is measured normally.
    expect(equityCurveReturns([0, 50, 60])).toEqual([(60 - 50) / 50])
  })

  it('omits periods whose prior equity is non-positive rather than returning Infinity', () => {
    const returns = equityCurveReturns([-10, 5, 10])
    expect(returns.every((r) => Number.isFinite(r))).toBe(true)
    // -10 -> 5 is undefined (prior <= 0); 5 -> 10 is +100%.
    expect(returns).toEqual([1])
  })

  it('skips periods touching a non-finite value, keeping the series finite', () => {
    const returns = equityCurveReturns([100, NaN, 200, 220])
    expect(returns.every((r) => Number.isFinite(r))).toBe(true)
    // 100->NaN skipped (current non-finite), NaN->200 skipped (prior non-finite),
    // 200->220 = +10%.
    expect(returns).toHaveLength(1)
    expect(returns[0]).toBeCloseTo(0.1, 10)
  })

  it('returns an empty series for curves with fewer than two points', () => {
    expect(equityCurveReturns([])).toEqual([])
    expect(equityCurveReturns([100])).toEqual([])
  })
})
