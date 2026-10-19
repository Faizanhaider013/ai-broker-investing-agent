/**
 * Offline Pine Script catalog complexity benchmark.
 *
 * Reads the committed catalog (`src/algo-stategies/algo-strategies.json`) and
 * produces a deterministic, explainable "conversion complexity" report: for
 * every entry it statically detects the Pine features that make a port to the
 * project's `TradeSignal` convention risky, assigns a documented weighted
 * score, and classifies each entry into a `low` / `medium` / `high` complexity
 * tier (the suggested conversion priority).
 *
 * SAFETY — this benchmark is intentionally inert:
 *   - It ONLY reads the catalog JSON from disk. No network, no API keys, no AI
 *     provider, no trading API, no broker.
 *   - It NEVER executes Pine Script or any generated TypeScript. All analysis is
 *     pure string/regex inspection of the committed source.
 *   - Static detection reports feature PRESENCE and COUNTS only; it never claims
 *     the detected features are semantically equivalent to anything, and the
 *     score is deliberately kept separate from the raw feature counts.
 *   - Writing a report to a file never overwrites an existing file unless the
 *     caller passes `--force`. By default the report only goes to stdout, so no
 *     generated artifact lands in committed source unless explicitly requested.
 *
 * Usage:
 *   bun scripts/pine-benchmark.ts                       # JSON report to stdout
 *   bun scripts/pine-benchmark.ts --limit=10            # top 10 most complex
 *   bun scripts/pine-benchmark.ts --limit=10 --order=lowest
 *   bun scripts/pine-benchmark.ts --out=report.json     # write a file (no overwrite)
 *   bun scripts/pine-benchmark.ts --out=report.json --force
 *   bun scripts/pine-benchmark.ts --catalog=/path/to/catalog.json
 */

import fs from "node:fs";

import {
  DEFAULT_CATALOG_PATH,
  SUPPORTED_PINE_VERSIONS,
  loadCatalog,
  type CatalogEntry,
  type PineVersion,
} from "./pine-convert";

// ---------------------------------------------------------------------------
// Feature model
// ---------------------------------------------------------------------------

/**
 * A statically-detectable Pine feature.
 *
 * `weight` is the per-feature contribution to the complexity score when the
 * feature is PRESENT (the score is presence-weighted, never count-weighted —
 * see {@link scoreFeatures}). `representable` records whether the project's
 * target `TradeSignal` type ({ action, confidence, reasoning, timestamp }) can
 * faithfully carry this behaviour. Features that CANNOT be represented
 * (prices, sizes, sides, multi-timeframe data) carry the heaviest weights
 * because they are exactly where a port silently loses fidelity.
 */
export interface PineFeature {
  id: string;
  label: string;
  /** Presence-weight added to the complexity score. Higher = riskier. */
  weight: number;
  /** Whether `TradeSignal` can represent this feature faithfully. */
  representable: boolean;
  /** One-line rationale for the weight, surfaced in the report. */
  rationale: string;
  /** Global, case-insensitive matcher run against comment-stripped source. */
  pattern: RegExp;
}

/**
 * The feature catalog, ordered from most to least conversion risk.
 *
 * Patterns are matched against source with line comments removed (see
 * {@link stripLineComments}) so a commented-out `strategy.exit(...)` or prose
 * mentioning "trailing stop" is not counted as an executable feature. Each
 * pattern carries the global flag so {@link countMatches} can tally
 * occurrences; the `lastIndex` is always reset before use.
 */
export const PINE_FEATURES: readonly PineFeature[] = [
  {
    id: "trailingStop",
    label: "Trailing stop",
    weight: 5,
    representable: false,
    rationale:
      "Requires continuous intrabar price tracking; TradeSignal carries no price or stop state.",
    pattern: /trail_points|trail_offset|trail_price|trailing\s*stop|trailingstop/gi,
  },
  {
    id: "pyramiding",
    label: "Pyramiding / scaling in",
    weight: 5,
    representable: false,
    rationale:
      "Multiple simultaneous entries and position scaling cannot be expressed by one BUY/SELL/HOLD signal per bar.",
    pattern: /\bpyramiding\b/gi,
  },
  {
    id: "requestSecurity",
    label: "Multi-timeframe request.security",
    weight: 4,
    representable: false,
    rationale:
      "Pulls data from another symbol/timeframe; the single-series bar input cannot supply it.",
    pattern: /request\.security\s*\(|\bsecurity\s*\(/gi,
  },
  {
    id: "positionSizing",
    label: "Explicit position sizing",
    weight: 4,
    representable: false,
    rationale:
      "Quantity / percent-of-equity sizing has no field in TradeSignal (confidence is not size).",
    pattern:
      /default_qty_type|default_qty_value|percent_of_equity|strategy\.fixed|strategy\.cash|strategy\.percent_of_equity|\bqty\s*=/gi,
  },
  {
    id: "strategyExit",
    label: "strategy.exit orders",
    weight: 3,
    representable: false,
    rationale:
      "Exit orders attach stop/limit/trail levels to a named entry; only the resulting direction survives the port.",
    pattern: /strategy\.exit\s*\(/gi,
  },
  {
    id: "stopLoss",
    label: "Stop-loss level",
    weight: 3,
    representable: false,
    rationale: "Stop price cannot be carried; it can only be re-expressed as reasoning text.",
    pattern: /\bstop_?loss\b|\bstop\s*=/gi,
  },
  {
    id: "takeProfit",
    label: "Take-profit level",
    weight: 3,
    representable: false,
    rationale: "Target price cannot be carried; it can only be re-expressed as reasoning text.",
    pattern: /\btake_?profit\b|\bprofit\s*=|\blimit\s*=/gi,
  },
  {
    id: "atr",
    label: "ATR indicator",
    weight: 2,
    representable: true,
    rationale:
      "Computable from bars, but almost always feeds a stop/target, so it signals hidden price-level logic.",
    pattern: /\bta\.atr\s*\(|(?<![.\w])atr\s*\(/gi,
  },
  {
    id: "plotting",
    label: "Plotting",
    weight: 1,
    representable: true,
    rationale: "Purely visual; safely dropped in a signal-only port, so it adds minimal risk.",
    pattern: /\bplot\w*\s*\(|\bhline\s*\(|\bbgcolor\s*\(|\bfill\s*\(/gi,
  },
  {
    id: "alerts",
    label: "Alerts",
    weight: 1,
    representable: true,
    rationale: "External notification side-effect; irrelevant to the pure signal function.",
    pattern: /\balertcondition\s*\(|\balert\s*\(/gi,
  },
] as const;

// ---------------------------------------------------------------------------
// Scoring model (documented, deterministic)
// ---------------------------------------------------------------------------

/**
 * Complexity tier thresholds, applied to the presence-weighted score.
 *
 * The maximum possible score (every feature present) is the sum of all
 * weights = 31. Tiers:
 *   - `low`    : score <= LOW_MAX_SCORE  (6)   → safest, suggested first to port
 *   - `medium` : LOW_MAX_SCORE < score < HIGH_MIN_SCORE
 *   - `high`   : score >= HIGH_MIN_SCORE (15)  → highest fidelity risk, port last
 */
export const LOW_MAX_SCORE = 6;
export const HIGH_MIN_SCORE = 15;

export type Complexity = "low" | "medium" | "high";

/** The maximum attainable score (all features present). Documented in the report. */
export const MAX_SCORE = PINE_FEATURES.reduce((sum, f) => sum + f.weight, 0);

export type VersionStatus = "supported" | "unsupported" | "missing";

export interface VersionInfo {
  /** The supported version (5 or 6), or `null` when missing/unsupported. */
  version: PineVersion | null;
  /** The raw parsed version number, or `null` when no `//@version=` tag. */
  raw: number | null;
  status: VersionStatus;
}

export interface SourceAnalysis {
  /** Per-feature occurrence counts (0 when absent). */
  featureCounts: Record<string, number>;
  /** Ids of features present (count > 0), in {@link PINE_FEATURES} order. */
  detectedFeatures: string[];
  /** Detected features that `TradeSignal` cannot represent faithfully. */
  unrepresentableFeatures: string[];
  /** Presence-weighted complexity score. */
  score: number;
}

export interface StrategyReport extends SourceAnalysis {
  url: string;
  name: string;
  version: PineVersion | null;
  rawVersion: number | null;
  versionStatus: VersionStatus;
  isStrategy: boolean;
  /** False when the source is empty/missing, so feature analysis is unavailable. */
  analyzable: boolean;
  complexity: Complexity;
  warnings: string[];
}

export interface BenchmarkReport {
  catalogPath: string;
  totalEntries: number;
  /** Entries with usable (non-empty) source. */
  analyzableEntries: number;
  versionCounts: Record<string, number>;
  /** Number of entries in which each feature appears at least once. */
  featurePrevalence: Record<string, number>;
  scoring: {
    description: string;
    maxScore: number;
    thresholds: { lowMaxScore: number; highMinScore: number };
    weights: Array<{
      id: string;
      label: string;
      weight: number;
      representable: boolean;
      rationale: string;
    }>;
  };
  warnings: string[];
  strategies: StrategyReport[];
}

export type SortOrder = "highest" | "lowest";

// ---------------------------------------------------------------------------
// Pure analysis helpers (unit-tested)
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
 * Detect the Pine version from `//@version=N` on the RAW source (the tag lives
 * in a comment, so comment-stripping must not run first). Never throws: an
 * absent tag yields `missing`, an out-of-range version yields `unsupported`.
 */
export function detectVersionInfo(source: string): VersionInfo {
  const match = (source ?? "").match(/\/\/\s*@version\s*=\s*(\d+)/);
  if (!match) return { version: null, raw: null, status: "missing" };
  const raw = Number(match[1]);
  if ((SUPPORTED_PINE_VERSIONS as readonly number[]).includes(raw)) {
    return { version: raw as PineVersion, raw, status: "supported" };
  }
  return { version: null, raw, status: "unsupported" };
}

/** Whether the (comment-stripped) source contains a `strategy(...)` declaration. */
export function isStrategyScript(strippedSource: string): boolean {
  return /\bstrategy\s*\(/.test(strippedSource);
}

/** Presence-weighted score: sum the weight of every feature that is present. */
export function scoreFeatures(featureCounts: Record<string, number>): number {
  return PINE_FEATURES.reduce(
    (sum, f) => sum + ((featureCounts[f.id] ?? 0) > 0 ? f.weight : 0),
    0,
  );
}

/** Map a score to its complexity tier using the documented thresholds. */
export function classifyComplexity(score: number): Complexity {
  if (score <= LOW_MAX_SCORE) return "low";
  if (score >= HIGH_MIN_SCORE) return "high";
  return "medium";
}

/** Run feature detection over a block of source (expects RAW source). */
export function analyzeSource(source: string): SourceAnalysis {
  const stripped = stripLineComments(source ?? "");
  const featureCounts: Record<string, number> = {};
  const detectedFeatures: string[] = [];
  const unrepresentableFeatures: string[] = [];
  for (const feature of PINE_FEATURES) {
    const count = countMatches(feature.pattern, stripped);
    featureCounts[feature.id] = count;
    if (count > 0) {
      detectedFeatures.push(feature.id);
      if (!feature.representable) unrepresentableFeatures.push(feature.id);
    }
  }
  return {
    featureCounts,
    detectedFeatures,
    unrepresentableFeatures,
    score: scoreFeatures(featureCounts),
  };
}

/** Analyze a single catalog entry into a per-strategy report with warnings. */
export function analyzeEntry(entry: CatalogEntry): StrategyReport {
  const url = entry.url;
  const name = entry.name?.trim() || entry.url;
  const source = typeof entry.source === "string" ? entry.source : "";
  const hasSource = source.trim().length > 0;
  const versionInfo = detectVersionInfo(source);
  const warnings: string[] = [];

  if (!hasSource) {
    warnings.push("Empty or missing source: feature analysis unavailable.");
    return {
      url,
      name,
      version: versionInfo.version,
      rawVersion: versionInfo.raw,
      versionStatus: versionInfo.status,
      isStrategy: false,
      analyzable: false,
      complexity: "low",
      warnings,
      featureCounts: Object.fromEntries(PINE_FEATURES.map((f) => [f.id, 0])),
      detectedFeatures: [],
      unrepresentableFeatures: [],
      score: 0,
    };
  }

  const stripped = stripLineComments(source);
  const isStrat = isStrategyScript(stripped);
  const analysis = analyzeSource(source);

  if (versionInfo.status === "missing") {
    warnings.push("No //@version= tag found.");
  } else if (versionInfo.status === "unsupported") {
    warnings.push(
      `Unsupported Pine version ${versionInfo.raw}; converter supports ${SUPPORTED_PINE_VERSIONS.join(", ")}.`,
    );
  }
  if (!isStrat) {
    warnings.push("No strategy() declaration: likely an indicator/study, not convertible.");
  }
  if (analysis.unrepresentableFeatures.length > 0) {
    warnings.push(
      `Uses features TradeSignal cannot represent faithfully: ${analysis.unrepresentableFeatures.join(", ")}.`,
    );
  }

  return {
    url,
    name,
    version: versionInfo.version,
    rawVersion: versionInfo.raw,
    versionStatus: versionInfo.status,
    isStrategy: isStrat,
    analyzable: true,
    complexity: classifyComplexity(analysis.score),
    warnings,
    ...analysis,
  };
}

/**
 * Deterministic sort. Non-analyzable entries (no source) always sort last.
 * Among analyzable entries, `highest` orders by score descending and `lowest`
 * ascending; ties always break by `url` ascending so the order is stable and
 * reproducible.
 */
export function sortStrategies(
  strategies: readonly StrategyReport[],
  order: SortOrder = "highest",
): StrategyReport[] {
  const dir = order === "lowest" ? 1 : -1;
  return [...strategies].sort((a, b) => {
    if (a.analyzable !== b.analyzable) return a.analyzable ? -1 : 1;
    if (a.score !== b.score) return (a.score - b.score) * dir;
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  });
}

/** Find duplicate urls (documented-unique in the catalog); returns sorted uniques. */
export function findDuplicateUrls(catalog: readonly CatalogEntry[]): string[] {
  const seen = new Map<string, number>();
  for (const e of catalog) seen.set(e.url, (seen.get(e.url) ?? 0) + 1);
  return [...seen.entries()]
    .filter(([, n]) => n > 1)
    .map(([url]) => url)
    .sort();
}

/** Build the full benchmark report from an in-memory catalog. Pure. */
export function buildReport(
  catalog: readonly CatalogEntry[],
  options: { catalogPath?: string; order?: SortOrder; limit?: number } = {},
): BenchmarkReport {
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const order = options.order ?? "highest";
  const warnings: string[] = [];

  if (catalog.length === 0) {
    warnings.push("Catalog is empty: no strategies to benchmark.");
  }
  const duplicates = findDuplicateUrls(catalog);
  if (duplicates.length > 0) {
    warnings.push(
      `Catalog has ${duplicates.length} duplicate url(s) (expected unique): ${duplicates.join(", ")}.`,
    );
  }

  const analyzed = catalog.map(analyzeEntry);

  const versionCounts: Record<string, number> = { "5": 0, "6": 0, unsupported: 0, missing: 0 };
  const featurePrevalence: Record<string, number> = Object.fromEntries(
    PINE_FEATURES.map((f) => [f.id, 0]),
  );
  for (const s of analyzed) {
    if (s.versionStatus === "supported") versionCounts[String(s.version)]++;
    else versionCounts[s.versionStatus]++;
    for (const id of s.detectedFeatures) featurePrevalence[id]++;
  }

  let strategies = sortStrategies(analyzed, order);
  if (typeof options.limit === "number" && options.limit >= 0) {
    strategies = strategies.slice(0, options.limit);
  }

  return {
    catalogPath,
    totalEntries: catalog.length,
    analyzableEntries: analyzed.filter((s) => s.analyzable).length,
    versionCounts,
    featurePrevalence,
    scoring: {
      description:
        "Presence-weighted score: each listed feature adds its weight once when present (counts are reported separately and never scale the score). Higher score = more conversion risk, weighted toward features the target TradeSignal type cannot represent. Static detection reports presence only and does not prove semantic equivalence.",
      maxScore: MAX_SCORE,
      thresholds: { lowMaxScore: LOW_MAX_SCORE, highMinScore: HIGH_MIN_SCORE },
      weights: PINE_FEATURES.map((f) => ({
        id: f.id,
        label: f.label,
        weight: f.weight,
        representable: f.representable,
        rationale: f.rationale,
      })),
    },
    warnings,
    strategies,
  };
}

// ---------------------------------------------------------------------------
// Side-effecting pieces (kept thin)
// ---------------------------------------------------------------------------

/**
 * Serialize a report to a file. NEVER overwrites an existing file unless
 * `force` is set — uses the exclusive `wx` flag so an accidental clobber throws.
 */
export function writeReportFile(
  filePath: string,
  report: BenchmarkReport,
  options: { force?: boolean } = {},
): void {
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.force) {
    fs.writeFileSync(filePath, json);
  } else {
    fs.writeFileSync(filePath, json, { flag: "wx" }); // throw if the file exists
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

export function parseOrder(value: unknown): SortOrder {
  return value === "lowest" ? "lowest" : "highest";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const catalogPath = typeof args.catalog === "string" ? args.catalog : undefined;
  const order = parseOrder(args.order);
  const limit =
    typeof args.limit === "string" && args.limit.trim() !== "" ? Number(args.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
    console.error(`Invalid --limit value: ${args.limit}`);
    process.exit(2);
  }

  const catalog = loadCatalog(catalogPath);
  const report = buildReport(catalog, { catalogPath, order, limit });

  if (typeof args.out === "string" && args.out.trim() !== "") {
    try {
      writeReportFile(args.out, report, { force: args.force === true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `Refusing to write report: ${msg}. ` +
          `Pass --force to overwrite an existing file on purpose.`,
      );
      process.exit(1);
    }
    console.error(`Wrote benchmark report to ${args.out}`);
    return;
  }

  console.log(JSON.stringify(report, null, 2));
}

// Only run the CLI when executed directly, never when imported by tests.
if (/(^|[\\/])pine-benchmark\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
