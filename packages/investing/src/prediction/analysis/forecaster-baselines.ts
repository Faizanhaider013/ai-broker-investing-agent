/**
 * Historical baseline comparison, leakage checks, and selection stability.
 *
 * Baselines are category-specific. TRUST ranks only sufficiently sampled,
 * defined trade scores; Brier ranks only sufficiently sampled, defined forecast
 * scores; deterministic random controls draw from the matching eligible pool and
 * use the same selection size as Day 7's category selection. No combined metric
 * is created and trade/forecast results are not treated as directly comparable.
 *
 * Every window has a selection cutoff and a strictly later evaluation cutoff.
 * Selection uses evidence available by the former. Subsequent outcomes use only
 * evidence first available in `(selectionCutoff, evaluationCutoff]`. Stable IDs
 * present in the selection period are barred from the subsequent period, so the
 * same observation cannot be counted on both sides of the comparison.
 *
 * Leakage findings report what can be checked from caller-supplied timestamps
 * and identities. This module cannot authenticate provenance, timestamp truth,
 * completeness, or causal independence. Synthetic tests validate mechanics only
 * and do not establish real-world predictive performance.
 */

import type { BinaryForecastMetricsResult } from "./binary-forecast-metrics";
import type {
  EliteForecasterAssessment,
  ForecastEliteRankingEntry,
  TradeEliteRankingEntry,
} from "./elite-forecaster-selection";
import {
  evaluateForecastersHistorically,
  type HistoricalCoverageCompleteness,
  type HistoricalCutoffEvaluation,
  type HistoricalEvaluationOptions,
  type HistoricalEvaluationWarning,
  type HistoricalEvidenceExclusion,
  type HistoricalForecastEvidence,
  type HistoricalTradeEvidence,
} from "./historical-forecaster-evaluation";
import {
  DEFAULT_MIN_SAMPLE_SIZE,
  type ForecasterTrustScore,
} from "./trust-score";

export interface BaselineEvaluationWindow {
  id: string;
  /** Inclusive cutoff used for selection metrics and rankings. */
  selectionCutoff: number;
  /** Inclusive cutoff for subsequent evidence; must exceed selectionCutoff. */
  evaluationCutoff: number;
}

export interface ForecasterBaselineInput {
  windows: readonly BaselineEvaluationWindow[];
  tradeEvidence: readonly HistoricalTradeEvidence[];
  forecastEvidence: readonly HistoricalForecastEvidence[];
  coverage: {
    tradeHistory: HistoricalCoverageCompleteness;
    forecastHistory: HistoricalCoverageCompleteness;
  };
}

export interface ForecasterBaselineOptions {
  selection: HistoricalEvaluationOptions["selection"];
  /** Unsigned 32-bit seed for reproducible category-specific random controls. */
  randomSeed: number;
}

export type BaselineStrategy =
  | "trust"
  | "brier"
  | "random-trade"
  | "random-forecast"
  | "elite-trade"
  | "elite-forecast";

export interface TrustBaselineEntry {
  rank: number;
  forecasterId: string;
  trustScore: number;
  sampleSize: number;
}

export interface BrierBaselineEntry {
  rank: number;
  forecasterId: string;
  brierScore: number;
  sampleSize: number;
}

export interface BaselineSelection<TEntry> {
  candidatePool: string[];
  ranking: TEntry[];
  /** Matches the corresponding Day 7 elite cohort for fair selection counts. */
  selectionSize: number;
  selectedForecasterIds: string[];
}

export interface RandomBaselineSelection {
  candidatePool: string[];
  selectionSize: number;
  selectedForecasterIds: string[];
  seed: number;
}

export interface SubsequentOutcomeEntry {
  forecasterId: string;
  status:
    | "evaluated"
    | "insufficient-subsequent-evidence"
    | "missing-subsequent-evidence";
  hasSufficientSample: boolean;
  trust: ForecasterTrustScore | null;
  forecastMetrics: BinaryForecastMetricsResult | null;
}

export interface StrategySubsequentOutcomes {
  category: "trade" | "forecast";
  entries: SubsequentOutcomeEntry[];
}

export type LeakageSeverity = "info" | "warning" | "error";
export type LeakageStatus = "prevented" | "detected" | "limitation";

export type LeakageReason =
  | "trade-resolved-after-selection-cutoff"
  | "forecast-resolved-after-selection-cutoff"
  | "availability-after-selection-cutoff"
  | "incorrect-timestamp-ordering"
  | "duplicate-observation-id"
  | "conflicting-duplicate-observation-id"
  | "selection-evaluation-observation-overlap"
  | "overlapping-evaluation-windows"
  | "future-observation-influenced-ranking"
  | "malformed-evidence"
  | "timestamp-provenance-not-authenticated";

export interface LeakageFinding {
  severity: LeakageSeverity;
  status: LeakageStatus;
  reason: LeakageReason;
  category: "trade" | "forecast" | "window" | "global";
  affectedIds: string[];
  selectionCutoff: number | null;
  evaluationCutoff: number | null;
  detail: string;
}

export interface BaselineWindowResult {
  window: BaselineEvaluationWindow;
  selectionMetrics: EliteForecasterAssessment[];
  baselines: {
    trust: BaselineSelection<TrustBaselineEntry>;
    brier: BaselineSelection<BrierBaselineEntry>;
    randomTrade: RandomBaselineSelection;
    randomForecast: RandomBaselineSelection;
    eliteTrade: TradeEliteRankingEntry[];
    eliteForecast: ForecastEliteRankingEntry[];
  };
  subsequentOutcomes: Record<BaselineStrategy, StrategySubsequentOutcomes>;
  /** Day 8 diagnostics retained verbatim for each side of the window. */
  exclusions: {
    selection: HistoricalCutoffEvaluation["exclusions"];
    subsequent: HistoricalCutoffEvaluation["exclusions"];
  };
  evaluationWarnings: {
    selection: HistoricalEvaluationWarning[];
    subsequent: HistoricalEvaluationWarning[];
  };
  leakageFindings: LeakageFinding[];
  warnings: string[];
}

export type NonComparableTransitionReason =
  | "from-window-not-evaluable"
  | "to-window-not-evaluable"
  | "both-windows-not-evaluable";

export type InsufficientWindowReason =
  | "no-evidence"
  | "insufficient-evidence"
  | "no-eligible-candidates"
  | "zero-selection-size";

export interface SelectionTransition {
  strategy: BaselineStrategy;
  fromWindowId: string;
  toWindowId: string;
  retainedForecasterIds: string[];
  addedForecasterIds: string[];
  removedForecasterIds: string[];
  comparable: boolean;
  nonComparableReason: NonComparableTransitionReason | null;
  /** Jaccard overlap, or null when either window is not evaluable. */
  overlap: number | null;
  /** Rank delta is current rank minus previous rank; random controls have none. */
  rankChanges: Array<{
    forecasterId: string;
    previousRank: number;
    currentRank: number;
    delta: number;
  }>;
}

export interface InclusionFrequency {
  strategy: BaselineStrategy;
  forecasterId: string;
  selectedWindows: number;
  /** All supplied windows, retained for context; not the frequency denominator. */
  totalWindows: number;
  /** Windows where this strategy had an eligible pool and non-zero cohort. */
  evaluableWindows: number;
  insufficientWindows: number;
  /** selectedWindows / evaluableWindows. */
  frequency: number;
}

export interface InsufficientWindow {
  strategy: BaselineStrategy;
  windowId: string;
  reason: InsufficientWindowReason;
}

export interface NonComparableTransition {
  strategy: BaselineStrategy;
  fromWindowId: string;
  toWindowId: string;
  reason: NonComparableTransitionReason;
}

export interface StrategyConsistency {
  strategy: BaselineStrategy;
  comparableTransitions: number;
  nonComparableTransitions: number;
  meanOverlap: number | null;
}

export interface ForecasterBaselineResult {
  coverage: {
    basis: "caller-supplied-historical-evidence";
    provenance: "not-authenticated";
    tradeHistoryCompleteness: HistoricalCoverageCompleteness;
    forecastHistoryCompleteness: HistoricalCoverageCompleteness;
  };
  limitations: string[];
  windows: BaselineWindowResult[];
  leakageFindings: LeakageFinding[];
  stability: {
    transitions: SelectionTransition[];
    inclusionFrequency: InclusionFrequency[];
    consistency: StrategyConsistency[];
    insufficientWindows: InsufficientWindow[];
    nonComparableTransitions: NonComparableTransition[];
    warnings: string[];
  };
}

const STRATEGIES: readonly BaselineStrategy[] = [
  "trust",
  "brier",
  "random-trade",
  "random-forecast",
  "elite-trade",
  "elite-forecast",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function diagnosticId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateInputs(
  input: ForecasterBaselineInput,
  options: ForecasterBaselineOptions,
): BaselineEvaluationWindow[] {
  if (!isRecord(input)) throw new TypeError("input must be an object");
  if (!Array.isArray(input.windows) || input.windows.length === 0)
    throw new RangeError("windows must be a non-empty array");
  if (!Array.isArray(input.tradeEvidence))
    throw new TypeError("tradeEvidence must be an array");
  if (!Array.isArray(input.forecastEvidence))
    throw new TypeError("forecastEvidence must be an array");
  if (!isRecord(input.coverage))
    throw new TypeError("coverage metadata is required");
  if (!isRecord(options) || !isRecord(options.selection))
    throw new TypeError("selection options are required");
  if (!Number.isSafeInteger(options.randomSeed) || options.randomSeed < 0 || options.randomSeed > 0xffffffff)
    throw new RangeError("randomSeed must be an unsigned 32-bit integer");

  const windows: BaselineEvaluationWindow[] = [];
  const ids = new Set<string>();
  const intervals = new Set<string>();
  for (const value of input.windows as readonly unknown[]) {
    if (!isRecord(value) || !isIdentity(value.id))
      throw new TypeError("every window must have a trimmed non-empty id");
    const selectionCutoff = value.selectionCutoff;
    const evaluationCutoff = value.evaluationCutoff;
    if (
      typeof selectionCutoff !== "number" ||
      !Number.isFinite(selectionCutoff) ||
      typeof evaluationCutoff !== "number" ||
      !Number.isFinite(evaluationCutoff)
    )
      throw new TypeError("window cutoffs must be finite epoch seconds");
    if (evaluationCutoff <= selectionCutoff)
      throw new RangeError("evaluationCutoff must be after selectionCutoff");
    if (ids.has(value.id)) throw new RangeError("window ids must be unique");
    const interval = `${selectionCutoff}\u0000${evaluationCutoff}`;
    if (intervals.has(interval))
      throw new RangeError("evaluation window intervals must be unique");
    ids.add(value.id);
    intervals.add(interval);
    windows.push({ id: value.id, selectionCutoff, evaluationCutoff });
  }
  return windows.sort(
    (a, b) =>
      a.selectionCutoff - b.selectionCutoff ||
      a.evaluationCutoff - b.evaluationCutoff ||
      compareText(a.id, b.id),
  );
}

function historicalInput(
  input: ForecasterBaselineInput,
  cutoff: number,
  tradeEvidence = input.tradeEvidence,
  forecastEvidence = input.forecastEvidence,
) {
  return {
    cutoffs: [cutoff],
    tradeEvidence,
    forecastEvidence,
    coverage: input.coverage,
  };
}

function trustRanking(
  assessments: readonly EliteForecasterAssessment[],
): TrustBaselineEntry[] {
  return assessments
    .filter(row => row.trade.trust?.reliable === true && row.trade.trust.score !== null)
    .map(row => ({
      rank: 0,
      forecasterId: row.forecasterId,
      trustScore: row.trade.trust?.score as number,
      sampleSize: row.trade.trust?.sampleSize as number,
    }))
    .sort(
      (a, b) =>
        b.trustScore - a.trustScore || compareText(a.forecasterId, b.forecasterId),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function brierRanking(
  assessments: readonly EliteForecasterAssessment[],
  minSampleSize: number,
): BrierBaselineEntry[] {
  return assessments
    .filter(
      row =>
        row.forecast.metrics?.brierScore !== null &&
        row.forecast.metrics !== null &&
        row.forecast.metrics.sampleSize >= minSampleSize,
    )
    .map(row => ({
      rank: 0,
      forecasterId: row.forecasterId,
      brierScore: row.forecast.metrics?.brierScore as number,
      sampleSize: row.forecast.metrics?.sampleSize as number,
    }))
    .sort(
      (a, b) =>
        a.brierScore - b.brierScore || compareText(a.forecasterId, b.forecasterId),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSelection(
  pool: readonly string[],
  size: number,
  seed: number,
): string[] {
  const values = [...pool].sort(compareText);
  const random = mulberry32(seed);
  for (let index = values.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values.slice(0, Math.min(size, values.length));
}

function selectedIdsByStrategy(result: BaselineWindowResult): Record<BaselineStrategy, string[]> {
  return {
    trust: result.baselines.trust.selectedForecasterIds,
    brier: result.baselines.brier.selectedForecasterIds,
    "random-trade": result.baselines.randomTrade.selectedForecasterIds,
    "random-forecast": result.baselines.randomForecast.selectedForecasterIds,
    "elite-trade": result.baselines.eliteTrade.map(row => row.forecasterId),
    "elite-forecast": result.baselines.eliteForecast.map(row => row.forecasterId),
  };
}

function rankedIdsByStrategy(result: BaselineWindowResult): Record<BaselineStrategy, string[]> {
  return {
    trust: result.baselines.trust.ranking.map(row => row.forecasterId),
    brier: result.baselines.brier.ranking.map(row => row.forecasterId),
    "random-trade": [],
    "random-forecast": [],
    "elite-trade": result.baselines.eliteTrade.map(row => row.forecasterId),
    "elite-forecast": result.baselines.eliteForecast.map(row => row.forecasterId),
  };
}

function outcomeEntries(
  ids: readonly string[],
  category: "trade" | "forecast",
  assessments: readonly EliteForecasterAssessment[],
  minimumSampleSize: number,
): StrategySubsequentOutcomes {
  const byId = new Map(assessments.map(row => [row.forecasterId, row]));
  return {
    category,
    entries: ids.map(forecasterId => {
      const row = byId.get(forecasterId);
      const trust = category === "trade" ? row?.trade.trust ?? null : null;
      const forecastMetrics =
        category === "forecast" ? row?.forecast.metrics ?? null : null;
      const hasEvidence = trust !== null || forecastMetrics !== null;
      const hasSufficientSample =
        category === "trade"
          ? trust?.hasSufficientSample === true
          : forecastMetrics !== null &&
            forecastMetrics.sampleSize >= minimumSampleSize;
      return {
        forecasterId,
        status:
          !hasEvidence
            ? "missing-subsequent-evidence"
            : hasSufficientSample
              ? "evaluated"
              : "insufficient-subsequent-evidence",
        hasSufficientSample,
        trust,
        forecastMetrics,
      };
    }),
  };
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function relevantIdSet(
  values: readonly unknown[],
  selectionCutoff: number,
): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !isIdentity(value.id)) continue;
    if (
      finiteTimestamp(value.availabilityTimestamp) &&
      value.availabilityTimestamp <= selectionCutoff
    )
      ids.add(value.id);
  }
  return ids;
}

function subsequentEvidence<T>(
  values: readonly T[],
  selectionCutoff: number,
  selectionIds: ReadonlySet<string>,
): T[] {
  return values.filter(value => {
    if (!isRecord(value)) return false;
    return (
      isIdentity(value.id) &&
      finiteTimestamp(value.availabilityTimestamp) &&
      value.availabilityTimestamp > selectionCutoff &&
      !selectionIds.has(value.id)
    );
  });
}

function pushFinding(
  findings: LeakageFinding[],
  finding: LeakageFinding,
): void {
  if (finding.affectedIds.length === 0 && finding.reason !== "timestamp-provenance-not-authenticated")
    return;
  findings.push({
    ...finding,
    affectedIds: [...new Set(finding.affectedIds)].sort(compareText),
  });
}

function duplicateFindingsFromExclusions(
  exclusions: readonly HistoricalEvidenceExclusion[],
  window: BaselineEvaluationWindow,
  phase: "selection" | "subsequent evaluation",
): LeakageFinding[] {
  const duplicateIds = new Map<
    string,
    { category: "trade" | "forecast"; conflict: boolean }
  >();
  for (const exclusion of exclusions) {
    if (exclusion.observationId === null) continue;
    const conflict = exclusion.reasons.includes("conflicting-duplicate-id");
    const duplicate = exclusion.reasons.includes("duplicate-id");
    if (!conflict && !duplicate) continue;
    const current = duplicateIds.get(exclusion.observationId);
    duplicateIds.set(exclusion.observationId, {
      category: exclusion.category,
      conflict: conflict || current?.conflict === true,
    });
  }
  const findings: LeakageFinding[] = [];
  for (const id of [...duplicateIds.keys()].sort(compareText)) {
    const duplicate = duplicateIds.get(id) as {
      category: "trade" | "forecast";
      conflict: boolean;
    };
    findings.push({
      severity: duplicate.conflict ? "error" : "warning",
      status: "detected",
      reason: duplicate.conflict
        ? "conflicting-duplicate-observation-id"
        : "duplicate-observation-id",
      category: duplicate.category,
      affectedIds: [id],
      selectionCutoff: window.selectionCutoff,
      evaluationCutoff: window.evaluationCutoff,
      detail: duplicate.conflict
        ? `Rows sharing this stable ID conflict and were rejected during ${phase}.`
        : `Repeated identical rows were deduplicated during ${phase}.`,
    });
  }
  return findings;
}

function windowLeakageFindings(
  input: ForecasterBaselineInput,
  window: BaselineEvaluationWindow,
  selectionTradeIds: ReadonlySet<string>,
  selectionForecastIds: ReadonlySet<string>,
  rankingsMatchSnapshot: boolean,
  selectionExclusions: readonly HistoricalEvidenceExclusion[],
  subsequentExclusions: readonly HistoricalEvidenceExclusion[],
): LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  const scan = (
    category: "trade" | "forecast",
    values: readonly unknown[],
  ) => {
    const resolvedAfter: string[] = [];
    const availableAfter: string[] = [];
    const incorrect: string[] = [];
    const malformed: string[] = [];
    const overlap: string[] = [];
    const selectionIds = category === "trade" ? selectionTradeIds : selectionForecastIds;
    for (const value of values) {
      if (!isRecord(value)) {
        malformed.push("<unknown>");
        continue;
      }
      const id = diagnosticId(value.id) ?? "<unknown>";
      if (
        finiteTimestamp(value.resolutionTimestamp) &&
        value.resolutionTimestamp > window.selectionCutoff
      )
        resolvedAfter.push(id);
      if (
        finiteTimestamp(value.availabilityTimestamp) &&
        value.availabilityTimestamp > window.selectionCutoff
      )
        availableAfter.push(id);
      if (
        !finiteTimestamp(value.resolutionTimestamp) ||
        !finiteTimestamp(value.availabilityTimestamp) ||
        value.availabilityTimestamp < value.resolutionTimestamp ||
        (category === "forecast" &&
          finiteTimestamp(value.forecastTimestamp) &&
          value.forecastTimestamp >= value.resolutionTimestamp)
      )
        incorrect.push(id);
      if (
        selectionIds.has(id) &&
        finiteTimestamp(value.availabilityTimestamp) &&
        value.availabilityTimestamp > window.selectionCutoff
      )
        overlap.push(id);
    }
    pushFinding(findings, {
      severity: "info",
      status: "prevented",
      reason:
        category === "trade"
          ? "trade-resolved-after-selection-cutoff"
          : "forecast-resolved-after-selection-cutoff",
      category,
      affectedIds: resolvedAfter,
      selectionCutoff: window.selectionCutoff,
      evaluationCutoff: window.evaluationCutoff,
      detail: "Resolution after selection is excluded from selection metrics.",
    });
    pushFinding(findings, {
      severity: "info",
      status: "prevented",
      reason: "availability-after-selection-cutoff",
      category,
      affectedIds: availableAfter,
      selectionCutoff: window.selectionCutoff,
      evaluationCutoff: window.evaluationCutoff,
      detail: "Evidence unavailable at selection is excluded from selection metrics.",
    });
    pushFinding(findings, {
      severity: "error",
      status: "detected",
      reason: "incorrect-timestamp-ordering",
      category,
      affectedIds: incorrect,
      selectionCutoff: window.selectionCutoff,
      evaluationCutoff: window.evaluationCutoff,
      detail: "Timestamp ordering is invalid or cannot be verified from finite values.",
    });
    pushFinding(findings, {
      severity: "error",
      status: "detected",
      reason: "selection-evaluation-observation-overlap",
      category,
      affectedIds: overlap,
      selectionCutoff: window.selectionCutoff,
      evaluationCutoff: window.evaluationCutoff,
      detail: "A stable ID appears in both periods and is barred from subsequent outcomes.",
    });
    pushFinding(findings, {
      severity: "warning",
      status: "detected",
      reason: "malformed-evidence",
      category,
      affectedIds: malformed,
      selectionCutoff: window.selectionCutoff,
      evaluationCutoff: window.evaluationCutoff,
      detail: "Malformed evidence cannot be temporally classified.",
    });
  };
  scan("trade", input.tradeEvidence as readonly unknown[]);
  scan("forecast", input.forecastEvidence as readonly unknown[]);
  findings.push(
    ...duplicateFindingsFromExclusions(
      selectionExclusions,
      window,
      "selection",
    ),
    ...duplicateFindingsFromExclusions(
      subsequentExclusions,
      window,
      "subsequent evaluation",
    ),
  );
  if (!rankingsMatchSnapshot)
    findings.push({
      severity: "error",
      status: "detected",
      reason: "future-observation-influenced-ranking",
      category: "window",
      affectedIds: [window.id],
      selectionCutoff: window.selectionCutoff,
      evaluationCutoff: window.evaluationCutoff,
      detail: "Selection rankings differ after future observations are removed.",
    });
  findings.push({
    severity: "info",
    status: "limitation",
    reason: "timestamp-provenance-not-authenticated",
    category: "global",
    affectedIds: [],
    selectionCutoff: window.selectionCutoff,
    evaluationCutoff: window.evaluationCutoff,
    detail: "Checks trust caller-supplied identities and timestamps and cannot authenticate them.",
  });
  return findings.sort(compareFindings);
}

function compareFindings(a: LeakageFinding, b: LeakageFinding): number {
  return (
    (a.selectionCutoff ?? Number.NEGATIVE_INFINITY) -
      (b.selectionCutoff ?? Number.NEGATIVE_INFINITY) ||
    compareText(a.category, b.category) ||
    compareText(a.reason, b.reason) ||
    compareText(a.affectedIds.join("\u0000"), b.affectedIds.join("\u0000"))
  );
}

function selectionSignature(evaluation: {
  forecasters: readonly EliteForecasterAssessment[];
  tradeRanking: readonly TradeEliteRankingEntry[];
  forecastRanking: readonly ForecastEliteRankingEntry[];
}, forecastMinSampleSize: number): string {
  return JSON.stringify({
    trustBaseline: trustRanking(evaluation.forecasters).map(row => [
      row.forecasterId,
      row.trustScore,
      row.sampleSize,
    ]),
    brierBaseline: brierRanking(
      evaluation.forecasters,
      forecastMinSampleSize,
    ).map(row => [row.forecasterId, row.brierScore, row.sampleSize]),
    trade: evaluation.tradeRanking.map(row => [row.forecasterId, row.trustScore]),
    forecast: evaluation.forecastRanking.map(row => [row.forecasterId, row.brierScore]),
  });
}

function strategyCategory(strategy: BaselineStrategy): "trade" | "forecast" {
  return strategy === "trust" ||
    strategy === "random-trade" ||
    strategy === "elite-trade"
    ? "trade"
    : "forecast";
}

function insufficientWindowReason(
  result: BaselineWindowResult,
  strategy: BaselineStrategy,
): InsufficientWindowReason | null {
  const category = strategyCategory(strategy);
  const warnings = result.evaluationWarnings.selection;
  if (
    warnings.includes(
      category === "trade"
        ? "no-trade-evidence-available"
        : "no-forecast-evidence-available",
    )
  )
    return "no-evidence";
  if (
    warnings.includes(
      category === "trade"
        ? "insufficient-trade-sample"
        : "insufficient-forecast-sample",
    )
  )
    return "insufficient-evidence";
  const baseline =
    category === "trade" ? result.baselines.trust : result.baselines.brier;
  if (baseline.candidatePool.length === 0) return "no-eligible-candidates";
  if (baseline.selectionSize === 0) return "zero-selection-size";
  return null;
}

function buildStability(windows: readonly BaselineWindowResult[]) {
  const insufficientWindows: InsufficientWindow[] = [];
  for (const strategy of STRATEGIES) {
    for (const window of windows) {
      const reason = insufficientWindowReason(window, strategy);
      if (reason !== null)
        insufficientWindows.push({
          strategy,
          windowId: window.window.id,
          reason,
        });
    }
  }

  const transitions: SelectionTransition[] = [];
  const nonComparableTransitions: NonComparableTransition[] = [];
  for (let index = 1; index < windows.length; index++) {
    const previous = windows[index - 1];
    const current = windows[index];
    const previousSelected = selectedIdsByStrategy(previous);
    const currentSelected = selectedIdsByStrategy(current);
    const previousRanked = rankedIdsByStrategy(previous);
    const currentRanked = rankedIdsByStrategy(current);
    for (const strategy of STRATEGIES) {
      const previousReason = insufficientWindowReason(previous, strategy);
      const currentReason = insufficientWindowReason(current, strategy);
      const comparable = previousReason === null && currentReason === null;
      const nonComparableReason: NonComparableTransitionReason | null =
        comparable
          ? null
          : previousReason !== null && currentReason !== null
            ? "both-windows-not-evaluable"
            : previousReason !== null
              ? "from-window-not-evaluable"
              : "to-window-not-evaluable";
      const before = new Set(previousSelected[strategy]);
      const after = new Set(currentSelected[strategy]);
      const retained = comparable
        ? [...before].filter(id => after.has(id)).sort(compareText)
        : [];
      const added = comparable
        ? [...after].filter(id => !before.has(id)).sort(compareText)
        : [];
      const removed = comparable
        ? [...before].filter(id => !after.has(id)).sort(compareText)
        : [];
      const union = new Set([...before, ...after]);
      const overlap =
        !comparable || union.size === 0 ? null : retained.length / union.size;
      const previousRanks = new Map(
        previousRanked[strategy].map((id, rank) => [id, rank + 1]),
      );
      const currentRanks = new Map(
        currentRanked[strategy].map((id, rank) => [id, rank + 1]),
      );
      const rankChanges = comparable
        ? [...previousRanks.keys()]
            .filter(id => currentRanks.has(id))
            .sort(compareText)
            .map(forecasterId => {
              const previousRank = previousRanks.get(forecasterId) as number;
              const currentRank = currentRanks.get(forecasterId) as number;
              return {
                forecasterId,
                previousRank,
                currentRank,
                delta: currentRank - previousRank,
              };
            })
        : [];
      transitions.push({
        strategy,
        fromWindowId: previous.window.id,
        toWindowId: current.window.id,
        retainedForecasterIds: retained,
        addedForecasterIds: added,
        removedForecasterIds: removed,
        comparable,
        nonComparableReason,
        overlap,
        rankChanges,
      });
      if (nonComparableReason !== null)
        nonComparableTransitions.push({
          strategy,
          fromWindowId: previous.window.id,
          toWindowId: current.window.id,
          reason: nonComparableReason,
        });
    }
  }

  const inclusionFrequency: InclusionFrequency[] = [];
  for (const strategy of STRATEGIES) {
    const evaluableWindows = windows.filter(
      window => insufficientWindowReason(window, strategy) === null,
    );
    const counts = new Map<string, number>();
    for (const window of evaluableWindows) {
      for (const id of selectedIdsByStrategy(window)[strategy])
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const id of [...counts.keys()].sort()) {
      const selectedWindows = counts.get(id) as number;
      inclusionFrequency.push({
        strategy,
        forecasterId: id,
        selectedWindows,
        totalWindows: windows.length,
        evaluableWindows: evaluableWindows.length,
        insufficientWindows: windows.length - evaluableWindows.length,
        frequency: selectedWindows / evaluableWindows.length,
      });
    }
  }
  const consistency: StrategyConsistency[] = STRATEGIES.map(strategy => {
    const overlaps = transitions
      .filter(row => row.strategy === strategy && row.overlap !== null)
      .map(row => row.overlap as number);
    return {
      strategy,
      comparableTransitions: overlaps.length,
      nonComparableTransitions: transitions.filter(
        row => row.strategy === strategy && !row.comparable,
      ).length,
      meanOverlap:
        overlaps.length === 0
          ? null
          : overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length,
    };
  });
  return {
    transitions,
    inclusionFrequency,
    consistency,
    insufficientWindows,
    nonComparableTransitions,
    warnings:
      windows.length < 2
        ? ["at least two windows are required for transition stability"]
        : [],
  };
}

function overlappingWindowFindings(
  windows: readonly BaselineEvaluationWindow[],
): LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  for (let left = 0; left < windows.length; left++) {
    for (let right = left + 1; right < windows.length; right++) {
      const a = windows[left];
      const b = windows[right];
      if (
        Math.max(a.selectionCutoff, b.selectionCutoff) <
        Math.min(a.evaluationCutoff, b.evaluationCutoff)
      )
        findings.push({
          severity: "warning",
          status: "detected",
          reason: "overlapping-evaluation-windows",
          category: "window",
          affectedIds: [a.id, b.id].sort(compareText),
          selectionCutoff: b.selectionCutoff,
          evaluationCutoff: Math.min(a.evaluationCutoff, b.evaluationCutoff),
          detail: "Subsequent evaluation intervals overlap, so window outcomes are not independent.",
        });
    }
  }
  return findings;
}

/**
 * Builds fair category-specific baselines, subsequent outcomes, leakage findings,
 * and stability statistics from caller-supplied historical evidence.
 */
export function evaluateForecasterBaselines(
  input: ForecasterBaselineInput,
  options: ForecasterBaselineOptions,
): ForecasterBaselineResult {
  const windows = validateInputs(input, options);
  const results: BaselineWindowResult[] = windows.map(window => {
    const selection = evaluateForecastersHistorically(
      historicalInput(input, window.selectionCutoff),
      { selection: options.selection },
    ).evaluations[0];
    const selectionTradeIds = relevantIdSet(
      input.tradeEvidence as readonly unknown[],
      window.selectionCutoff,
    );
    const selectionForecastIds = relevantIdSet(
      input.forecastEvidence as readonly unknown[],
      window.selectionCutoff,
    );
    const laterTrades = subsequentEvidence(
      input.tradeEvidence,
      window.selectionCutoff,
      selectionTradeIds,
    );
    const laterForecasts = subsequentEvidence(
      input.forecastEvidence,
      window.selectionCutoff,
      selectionForecastIds,
    );
    const subsequent = evaluateForecastersHistorically(
      historicalInput(
        input,
        window.evaluationCutoff,
        laterTrades,
        laterForecasts,
      ),
      { selection: options.selection },
    ).evaluations[0];

    const snapshotTrades = (input.tradeEvidence as readonly unknown[]).filter(
      (row): row is HistoricalTradeEvidence =>
        isRecord(row) &&
        finiteTimestamp(row.resolutionTimestamp) &&
        finiteTimestamp(row.availabilityTimestamp) &&
        row.resolutionTimestamp <= window.selectionCutoff &&
        row.availabilityTimestamp <= window.selectionCutoff,
    );
    const snapshotForecasts = (input.forecastEvidence as readonly unknown[]).filter(
      (row): row is HistoricalForecastEvidence =>
        isRecord(row) &&
        finiteTimestamp(row.resolutionTimestamp) &&
        finiteTimestamp(row.availabilityTimestamp) &&
        row.resolutionTimestamp <= window.selectionCutoff &&
        row.availabilityTimestamp <= window.selectionCutoff,
    );
    const snapshot = evaluateForecastersHistorically(
      historicalInput(
        input,
        window.selectionCutoff,
        snapshotTrades,
        snapshotForecasts,
      ),
      { selection: options.selection },
    ).evaluations[0];
    const rankingsMatchSnapshot =
      selectionSignature(selection, options.selection.forecast.minSampleSize) ===
      selectionSignature(snapshot, options.selection.forecast.minSampleSize);

    const trust = trustRanking(selection.forecasters);
    const brier = brierRanking(
      selection.forecasters,
      options.selection.forecast.minSampleSize,
    );
    const tradeSelectionSize = selection.tradeRanking.length;
    const forecastSelectionSize = selection.forecastRanking.length;
    const tradePool = trust.map(row => row.forecasterId);
    const forecastPool = brier.map(row => row.forecasterId);
    const tradeSeed =
      (options.randomSeed ^ hashText(`${window.id}:trade:${window.selectionCutoff}`)) >>> 0;
    const forecastSeed =
      (options.randomSeed ^ hashText(`${window.id}:forecast:${window.selectionCutoff}`)) >>> 0;
    const trustSelection: BaselineSelection<TrustBaselineEntry> = {
      candidatePool: tradePool,
      ranking: trust,
      selectionSize: tradeSelectionSize,
      selectedForecasterIds: trust
        .slice(0, tradeSelectionSize)
        .map(row => row.forecasterId),
    };
    const brierSelection: BaselineSelection<BrierBaselineEntry> = {
      candidatePool: forecastPool,
      ranking: brier,
      selectionSize: forecastSelectionSize,
      selectedForecasterIds: brier
        .slice(0, forecastSelectionSize)
        .map(row => row.forecasterId),
    };
    const randomTrade: RandomBaselineSelection = {
      candidatePool: tradePool,
      selectionSize: tradeSelectionSize,
      selectedForecasterIds: randomSelection(
        tradePool,
        tradeSelectionSize,
        tradeSeed,
      ),
      seed: tradeSeed,
    };
    const randomForecast: RandomBaselineSelection = {
      candidatePool: forecastPool,
      selectionSize: forecastSelectionSize,
      selectedForecasterIds: randomSelection(
        forecastPool,
        forecastSelectionSize,
        forecastSeed,
      ),
      seed: forecastSeed,
    };
    const selected: Record<BaselineStrategy, string[]> = {
      trust: trustSelection.selectedForecasterIds,
      brier: brierSelection.selectedForecasterIds,
      "random-trade": randomTrade.selectedForecasterIds,
      "random-forecast": randomForecast.selectedForecasterIds,
      "elite-trade": selection.tradeRanking.map(row => row.forecasterId),
      "elite-forecast": selection.forecastRanking.map(row => row.forecasterId),
    };
    const subsequentOutcomes = {} as Record<
      BaselineStrategy,
      StrategySubsequentOutcomes
    >;
    for (const strategy of STRATEGIES)
      subsequentOutcomes[strategy] = outcomeEntries(
        selected[strategy],
        strategyCategory(strategy),
        subsequent.forecasters,
        strategyCategory(strategy) === "trade"
          ? options.selection.trade.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE
          : options.selection.forecast.minSampleSize,
      );

    return {
      window,
      selectionMetrics: selection.forecasters,
      baselines: {
        trust: trustSelection,
        brier: brierSelection,
        randomTrade,
        randomForecast,
        eliteTrade: selection.tradeRanking,
        eliteForecast: selection.forecastRanking,
      },
      subsequentOutcomes,
      exclusions: {
        selection: selection.exclusions,
        subsequent: subsequent.exclusions,
      },
      evaluationWarnings: {
        selection: selection.warnings,
        subsequent: subsequent.warnings,
      },
      leakageFindings: windowLeakageFindings(
        input,
        window,
        selectionTradeIds,
        selectionForecastIds,
        rankingsMatchSnapshot,
        selection.exclusions.historicalEvidence,
        subsequent.exclusions.historicalEvidence,
      ),
      warnings: [
        ...selection.warnings,
        ...(tradePool.length === 0 ? ["no eligible TRUST baseline candidates"] : []),
        ...(forecastPool.length === 0 ? ["no eligible Brier baseline candidates"] : []),
        ...(tradePool.length > 0 && tradeSelectionSize === 0
          ? ["no comparable trade selection size because Day 7 selected no trade elite"]
          : []),
        ...(forecastPool.length > 0 && forecastSelectionSize === 0
          ? ["no comparable forecast selection size because Day 7 selected no forecast elite"]
          : []),
      ],
    } satisfies BaselineWindowResult;
  });

  const overlapFindings = overlappingWindowFindings(windows);
  const allFindings = [
    ...results.flatMap(row => row.leakageFindings),
    ...overlapFindings,
  ].sort(compareFindings);
  return {
    coverage: {
      basis: "caller-supplied-historical-evidence",
      provenance: "not-authenticated",
      tradeHistoryCompleteness: input.coverage.tradeHistory,
      forecastHistoryCompleteness: input.coverage.forecastHistory,
    },
    limitations: [
      "TRUST and Brier use different evidence categories and are not directly comparable.",
      "Random controls are category-specific and match only their category candidate pool and size.",
      "No statistical significance or causal-performance claim is computed.",
      "Evidence provenance, completeness, identities, and timestamps are caller-supplied and unauthenticated.",
      "Synthetic test outcomes do not establish real-world predictive performance.",
    ],
    windows: results,
    leakageFindings: allFindings,
    stability: buildStability(results),
  };
}
