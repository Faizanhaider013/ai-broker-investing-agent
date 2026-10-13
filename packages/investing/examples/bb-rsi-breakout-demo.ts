/**
 * Offline demo of the BB + RSI breakout strategy.
 *
 * Runs entirely on synthetic OHLCV bars — no network, no broker, no
 * credentials. Uses a small-period config with a lower stdev multiplier so the
 * band breakouts are reachable without 30 warm-up bars; production use keeps
 * the Pine defaults (BB 30 / 2.0, RSI 13, TP ×1.03 / ×0.97).
 *
 *   bun examples/bb-rsi-breakout-demo.ts
 */

import { evaluateBbRsiBreakout, type BbRsiBreakoutBar } from "../src/stocks/index.js";

// Decline into an oversold break below the lower band (long entry at bar 4),
// then a rebound whose high reaches the +3% take-profit (exit at bar 7).
const closes = [100, 99, 98, 97, 96, 90, 85, 100];
const highs = closes;
const lows = closes;

const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
const bars: BbRsiBreakoutBar[] = closes.map((close, index) => ({
  date: new Date(baseTime + index * 86_400_000).toISOString(), // one bar per day
  close,
  high: highs[index],
  low: lows[index],
}));

const signals = evaluateBbRsiBreakout(bars, {
  bbPeriod: 5,
  bbStdDev: 1.0,
  rsiPeriod: 3,
  warmupBars: 5,
});

console.log("BB + RSI Breakout Strategy — synthetic replay\n");
console.log("bar  date        close  action  reasoning");
signals.forEach((signal, index) => {
  const date = bars[index].date.slice(0, 10);
  const close = String(bars[index].close).padStart(5);
  const action = signal.action.padEnd(6);
  console.log(`${String(index).padStart(3)}  ${date}  ${close}  ${action}  ${signal.reasoning}`);
});

const trades = signals.filter((s) => s.action !== "HOLD");
console.log(`\n${trades.length} actionable signal(s): ${trades.map((s) => s.action).join(", ")}`);
console.log(
  "\nNote: entries are emitted at the signal bar's close; to match TradingView's" +
    "\nbacktest a consumer fills entries at the NEXT bar's open, while the" +
    "\ntake-profit is a resting limit that fills intrabar at its level. TradeSignal" +
    "\ncannot carry that limit price — this is signal-only, it places no orders.",
);
