/**
 * Minimal, standalone Pine-feature detection primitives.
 *
 * This is the small slice of feature knowledge shared between the conversion
 * pipeline (`pine-convert.ts`) and the conformance checker
 * (`pine-conformance.ts`): the catalog of statically-detectable Pine features
 * (id, label, whether the target `TradeSignal` can represent them, and the
 * matcher), plus the comment-stripping and match-counting helpers they rely on.
 *
 * It is deliberately a LEAF module — it imports nothing else in the repo — so
 * neither consumer picks up a dependency on the heavier complexity benchmark
 * (`pine-benchmark.ts`, which lives on a separate branch/PR and owns the
 * scoring model). The benchmark may later reuse this module, but this module
 * never depends on it.
 *
 * Deterministic and offline: pure string/regex inspection only.
 */

// ---------------------------------------------------------------------------
// Feature model
// ---------------------------------------------------------------------------

/** A statically-detectable Pine feature (no scoring — that is the benchmark's). */
export interface PineFeature {
  id: string;
  label: string;
  /** Whether the project's `TradeSignal` type can represent this faithfully. */
  representable: boolean;
  /** Global, case-insensitive matcher run against comment-stripped source. */
  pattern: RegExp;
}

/**
 * The feature catalog, ordered from most to least conversion risk. Patterns are
 * matched against source with line comments removed (see {@link stripLineComments})
 * so a commented-out `strategy.exit(...)` or prose is never counted as an
 * executable feature. Each pattern carries the global flag so {@link countMatches}
 * can tally occurrences; `lastIndex` is always reset before use.
 */
export const PINE_FEATURES: readonly PineFeature[] = [
  {
    id: "trailingStop",
    label: "Trailing stop",
    representable: false,
    pattern: /trail_points|trail_offset|trail_price|trailing\s*stop|trailingstop/gi,
  },
  {
    id: "pyramiding",
    label: "Pyramiding / scaling in",
    representable: false,
    pattern: /\bpyramiding\b/gi,
  },
  {
    id: "requestSecurity",
    label: "Multi-timeframe request.security",
    representable: false,
    pattern: /request\.security\s*\(|\bsecurity\s*\(/gi,
  },
  {
    id: "positionSizing",
    label: "Explicit position sizing",
    representable: false,
    pattern:
      /default_qty_type|default_qty_value|percent_of_equity|strategy\.fixed|strategy\.cash|strategy\.percent_of_equity|\bqty\s*=/gi,
  },
  {
    id: "strategyExit",
    label: "strategy.exit orders",
    representable: false,
    pattern: /strategy\.exit\s*\(/gi,
  },
  {
    id: "stopLoss",
    label: "Stop-loss level",
    representable: false,
    pattern: /\bstop_?loss\b|\bstop\s*=/gi,
  },
  {
    id: "takeProfit",
    label: "Take-profit level",
    representable: false,
    pattern: /\btake_?profit\b|\bprofit\s*=|\blimit\s*=/gi,
  },
  {
    id: "atr",
    label: "ATR indicator",
    representable: true,
    pattern: /\bta\.atr\s*\(|(?<![.\w])atr\s*\(/gi,
  },
  {
    id: "plotting",
    label: "Plotting",
    representable: true,
    pattern: /\bplot\w*\s*\(|\bhline\s*\(|\bbgcolor\s*\(|\bfill\s*\(/gi,
  },
  {
    id: "alerts",
    label: "Alerts",
    representable: true,
    pattern: /\balertcondition\s*\(|\balert\s*\(/gi,
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Remove `//` line comments from Pine source while preserving `//` that appears
 * inside a string literal (single or double quoted, with backslash escapes).
 * Pine has no block comments, so this is a per-line scan. Used so that commented
 * code and prose are never counted as executable features.
 */
export function stripLineComments(source: string): string {
  const out: string[] = [];
  for (const line of (source ?? "").split(/\r?\n/)) {
    let inString: '"' | "'" | null = null;
    let escaped = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = ch;
        continue;
      }
      if (ch === "/" && line[i + 1] === "/") {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join("\n");
}

/** Count global, case-insensitive matches of a feature pattern (lastIndex-safe). */
export function countMatches(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) {
    count++;
    // Guard against a zero-width match stalling the loop.
    if (pattern.lastIndex === 0) break;
  }
  return count;
}

/**
 * Ids of the features that `TradeSignal` CANNOT represent faithfully and that
 * are present in `source`, in {@link PINE_FEATURES} order. This is the subset of
 * feature detection the conversion pipeline needs for the conformance
 * cross-check; it intentionally does not compute any complexity score.
 */
export function detectUnrepresentableFeatures(source: string): string[] {
  const stripped = stripLineComments(source ?? "");
  const out: string[] = [];
  for (const feature of PINE_FEATURES) {
    if (feature.representable) continue;
    if (countMatches(feature.pattern, stripped) > 0) out.push(feature.id);
  }
  return out;
}
