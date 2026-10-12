/**
 * Offline demo of the long-only EMA crossover strategy.
 *
 * Runs entirely on synthetic OHLCV bars — no network, no broker, no
 * credentials. Uses a small-period config so the signals are visible without
 * supplying 200 warm-up bars; production use keeps the Pine defaults
 * (9 / 20 / 200).
 *
 *   bun examples/ema-crossover-demo.ts
 */

import { evaluateEmaCrossover, type EmaCrossoverBar } from "../src/stocks/index.js";

// Down-trend (warm-up) → up-trend (entry) → pullback (exit).
const closes = [100, 98, 96, 94, 92, 90, 93, 97, 102, 108, 115, 112, 108, 103, 99];

const baseTime = Date.parse("2026-01-01T00:00:00.000Z");
const bars: EmaCrossoverBar[] = closes.map((close, index) => ({
  date: new Date(baseTime + index * 86_400_000).toISOString(), // one bar per day
  close,
}));

const signals = evaluateEmaCrossover(bars, {
  shortPeriod: 2,
  longPeriod: 4,
  trendPeriod: 6,
  warmupBars: 6,
});

console.log("Long Only EMA Strategy — synthetic replay\n");
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
  "\nNote: signals are emitted at the signal bar's close. To match TradingView's" +
    "\nbacktest, a consumer should fill the order at the NEXT bar's open.",
);
