/**
 * Deterministic historical evaluation harness for caller-supplied evidence.
 *
 * The harness evaluates the same evidence cohort at one or more inclusive
 * historical cutoffs. It delegates all TRUST, Brier, calibration, eligibility,
 * and ranking calculations to the existing Day 1-7 utilities; it never combines
 * trade and forecast metrics into a synthetic score.
 *
 * LOOK-AHEAD POLICY
 * `resolutionTimestamp` is when the underlying result became true/settled.
 * `availabilityTimestamp` is when the verified evidence became available to the
 * evaluator. An observation is eligible at a cutoff only when both timestamps
 * are at or before that cutoff, and availability may never predate resolution.
 * Duplicate/conflict detection is also cutoff-local: a later-available conflict
 * cannot retroactively poison an earlier evaluation.
 *
 * PROVENANCE AND COVERAGE
 * All evidence and completeness labels are supplied by the caller. This module
 * cannot authenticate provenance or prove that a history is complete. Callers
 * must provide verified evidence, truthful timestamps, and coverage labels that
 * are appropriate for the intended evaluation. Synthetic fixtures demonstrate
 * mechanics only; they are not evidence of real-world predictive performance.
 *
 * @example
 * ```ts
 * evaluateForecastersHistorically(
 *   {
 *     cutoffs: [1_700_000_000],
 *     tradeEvidence: [],
 *     forecastEvidence: [],
 *     coverage: { tradeHistory: "unknown", forecastHistory: "unknown" },
 *   },
 *   {
 *     selection: {
 *       trade: { minSampleSize: 25 },
 *       forecast: { minSampleSize: 25 },
 *     },
 *   },
 * );
 * ```
 */

import type { BinaryForecastObservation } from "./binary-forecast-metrics";
import {
  selectEliteForecasters,
  type EliteForecasterAssessment,
  type EliteForecasterEvidence,
  type EliteForecastSelectionOptions,
  type EliteTradeSelectionOptions,
  type ForecastEliteRankingEntry,
  type ForecasterInputExclusion,
  type ResolvedTradeEvidence,
  type TradeEliteRankingEntry,
} from "./elite-forecaster-selection";

/** Whether the caller asserts that the supplied history is complete. */
export type HistoricalCoverageCompleteness =
  | "complete"
  | "partial"
  | "unknown";

/** A resolved trade result plus the point when its verified evidence was known. */
export interface HistoricalTradeEvidence extends ResolvedTradeEvidence {
  forecasterId: string;
  /** Epoch seconds when this verified resolved-trade record became available. */
  availabilityTimestamp: number;
}

/** A verified binary forecast plus the point when its result record was known. */
export interface HistoricalForecastEvidence extends BinaryForecastObservation {
  /** Epoch seconds when this verified forecast/result join became available. */
  availabilityTimestamp: number;
}

export interface HistoricalEvaluationInput {
  /** Inclusive epoch-second evaluation cutoffs. Must be finite and unique. */
  cutoffs: readonly number[];
  /** Flat caller-supplied resolved-trade history across forecasters. */
  tradeEvidence: readonly HistoricalTradeEvidence[];
  /** Flat caller-supplied verified binary forecast history. */
  forecastEvidence: readonly HistoricalForecastEvidence[];
  /** Caller assertions; the harness does not independently verify them. */
  coverage: {
    tradeHistory: HistoricalCoverageCompleteness;
    forecastHistory: HistoricalCoverageCompleteness;
  };
}

export interface HistoricalEvaluationOptions {
  selection: {
    trade: EliteTradeSelectionOptions;
    forecast: EliteForecastSelectionOptions;
  };
}

export type HistoricalEvidenceExclusionReason =
  | "malformed-observation"
  | "invalid-id"
  | "invalid-forecaster-id"
  | "invalid-r-multiple"
  | "invalid-probability"
  | "invalid-forecast-timestamp"
  | "invalid-outcome"
  | "invalid-resolution-timestamp"
  | "invalid-availability-timestamp"
  | "availability-before-resolution"
  | "resolution-after-cutoff"
  | "availability-after-cutoff"
  | "duplicate-id"
  | "conflicting-duplicate-id";

export interface HistoricalEvidenceExclusion {
  category: "trade" | "forecast";
  observationId: string | null;
  forecasterId: string | null;
  reasons: HistoricalEvidenceExclusionReason[];
}

export type HistoricalEvaluationWarning =
  | "trade-history-completeness-not-verified"
  | "forecast-history-completeness-not-verified"
  | "no-trade-evidence-available"
  | "no-forecast-evidence-available"
  | "insufficient-trade-sample"
  | "insufficient-forecast-sample";

export interface HistoricalEvaluationCoverage {
  basis: "caller-supplied-historical-evidence";
  provenance: "not-authenticated";
  tradeHistoryCompleteness: HistoricalCoverageCompleteness;
  forecastHistoryCompleteness: HistoricalCoverageCompleteness;
  suppliedTradeObservations: number;
  suppliedForecastObservations: number;
  availableTradeObservations: number;
  availableForecastObservations: number;
  forecastersEvaluated: number;
}

export interface HistoricalCutoffEvaluation {
  cutoff: number;
  tradeRanking: TradeEliteRankingEntry[];
  forecastRanking: ForecastEliteRankingEntry[];
  eliteSelections: {
    tradeForecasterIds: string[];
    forecastForecasterIds: string[];
  };
  /** Per-forecaster TRUST and Brier/calibration metrics from Day 7. */
  forecasters: EliteForecasterAssessment[];
  exclusions: {
    historicalEvidence: HistoricalEvidenceExclusion[];
    selectionInputs: ForecasterInputExclusion[];
  };
  coverage: HistoricalEvaluationCoverage;
  warnings: HistoricalEvaluationWarning[];
}

export interface HistoricalEvaluationResult {
  coverage: {
    basis: "caller-supplied-historical-evidence";
    provenance: "not-authenticated";
    tradeHistoryCompleteness: HistoricalCoverageCompleteness;
    forecastHistoryCompleteness: HistoricalCoverageCompleteness;
  };
  /** Evaluations sorted by ascending cutoff, regardless of input order. */
  evaluations: HistoricalCutoffEvaluation[];
}

type EvidenceCategory = "trade" | "forecast";

interface AvailableTradeEvidence extends HistoricalTradeEvidence {}
interface AvailableForecastEvidence extends HistoricalForecastEvidence {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function diagnosticIdentity(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Numeric semantic equality for evidence, including invalid `NaN` sentinels. */
function sameNumber(a: unknown, b: unknown): boolean {
  return (
    a === b ||
    (typeof a === "number" &&
      typeof b === "number" &&
      Number.isNaN(a) &&
      Number.isNaN(b))
  );
}

function sameTradeEvidence(a: AvailableTradeEvidence, b: AvailableTradeEvidence): boolean {
  return (
    a.id === b.id &&
    a.forecasterId === b.forecasterId &&
    sameNumber(a.rMultiple, b.rMultiple) &&
    sameNumber(a.resolutionTimestamp, b.resolutionTimestamp) &&
    sameNumber(a.availabilityTimestamp, b.availabilityTimestamp)
  );
}

function sameForecastEvidence(
  a: AvailableForecastEvidence,
  b: AvailableForecastEvidence,
): boolean {
  return (
    a.id === b.id &&
    a.forecasterId === b.forecasterId &&
    a.eventId === b.eventId &&
    sameNumber(a.probabilityYes, b.probabilityYes) &&
    sameNumber(a.forecastTimestamp, b.forecastTimestamp) &&
    sameNumber(a.outcome, b.outcome) &&
    sameNumber(a.resolutionTimestamp, b.resolutionTimestamp) &&
    sameNumber(a.availabilityTimestamp, b.availabilityTimestamp)
  );
}

function exclusion(
  category: EvidenceCategory,
  observation: unknown,
  reasons: HistoricalEvidenceExclusionReason[],
): HistoricalEvidenceExclusion {
  const row = isRecord(observation) ? observation : undefined;
  return {
    category,
    observationId: diagnosticIdentity(row?.id),
    forecasterId: diagnosticIdentity(row?.forecasterId),
    reasons: [...reasons].sort(),
  };
}

function compareExclusions(
  a: HistoricalEvidenceExclusion,
  b: HistoricalEvidenceExclusion,
): number {
  return (
    compareText(a.category, b.category) ||
    compareText(a.observationId ?? "", b.observationId ?? "") ||
    compareText(a.forecasterId ?? "", b.forecasterId ?? "") ||
    compareText(a.reasons.join("\u0000"), b.reasons.join("\u0000"))
  );
}

function temporalReasons(
  category: EvidenceCategory,
  row: Record<string, unknown>,
  cutoff: number,
): HistoricalEvidenceExclusionReason[] {
  const reasons: HistoricalEvidenceExclusionReason[] = [];
  if (!isIdentity(row.id)) reasons.push("invalid-id");
  if (!isIdentity(row.forecasterId)) reasons.push("invalid-forecaster-id");
  if (
    category === "trade" &&
    (typeof row.rMultiple !== "number" || !Number.isFinite(row.rMultiple))
  )
    reasons.push("invalid-r-multiple");
  if (
    category === "forecast" &&
    (typeof row.probabilityYes !== "number" ||
      !Number.isFinite(row.probabilityYes) ||
      row.probabilityYes < 0 ||
      row.probabilityYes > 1)
  )
    reasons.push("invalid-probability");
  if (
    category === "forecast" &&
    (typeof row.forecastTimestamp !== "number" ||
      !Number.isFinite(row.forecastTimestamp))
  )
    reasons.push("invalid-forecast-timestamp");
  if (category === "forecast" && row.outcome !== 0 && row.outcome !== 1)
    reasons.push("invalid-outcome");
  if (
    typeof row.resolutionTimestamp !== "number" ||
    !Number.isFinite(row.resolutionTimestamp)
  )
    reasons.push("invalid-resolution-timestamp");
  if (
    typeof row.availabilityTimestamp !== "number" ||
    !Number.isFinite(row.availabilityTimestamp)
  )
    reasons.push("invalid-availability-timestamp");

  if (
    reasons.length === 0 &&
    (row.availabilityTimestamp as number) <
      (row.resolutionTimestamp as number)
  )
    reasons.push("availability-before-resolution");
  if (
    typeof row.resolutionTimestamp === "number" &&
    Number.isFinite(row.resolutionTimestamp) &&
    row.resolutionTimestamp > cutoff
  )
    reasons.push("resolution-after-cutoff");
  if (
    typeof row.availabilityTimestamp === "number" &&
    Number.isFinite(row.availabilityTimestamp) &&
    row.availabilityTimestamp > cutoff
  )
    reasons.push("availability-after-cutoff");
  return reasons;
}

function collectAvailable<T extends AvailableTradeEvidence | AvailableForecastEvidence>(
  category: EvidenceCategory,
  values: readonly unknown[],
  cutoff: number,
  same: (a: T, b: T) => boolean,
): { available: T[]; exclusions: HistoricalEvidenceExclusion[] } {
  const candidates: T[] = [];
  const exclusions: HistoricalEvidenceExclusion[] = [];

  for (const value of values) {
    if (!isRecord(value)) {
      exclusions.push(exclusion(category, value, ["malformed-observation"]));
      continue;
    }
    const reasons = temporalReasons(category, value, cutoff);
    if (reasons.length > 0) exclusions.push(exclusion(category, value, reasons));
    else candidates.push({ ...value } as unknown as T);
  }

  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.id) ?? [];
    group.push(candidate);
    groups.set(candidate.id, group);
  }

  const available: T[] = [];
  for (const id of [...groups.keys()].sort()) {
    const group = groups.get(id) as T[];
    if (!group.every(row => same(row, group[0]))) {
      for (const row of group)
        exclusions.push(exclusion(category, row, ["conflicting-duplicate-id"]));
      continue;
    }
    available.push(group[0]);
    for (let index = 1; index < group.length; index++)
      exclusions.push(exclusion(category, group[index], ["duplicate-id"]));
  }

  available.sort(
    (a, b) =>
      compareText(a.forecasterId, b.forecasterId) || compareText(a.id, b.id),
  );
  exclusions.sort(compareExclusions);
  return { available, exclusions };
}

function validateCompleteness(value: unknown, name: string): HistoricalCoverageCompleteness {
  if (value !== "complete" && value !== "partial" && value !== "unknown")
    throw new TypeError(`${name} must be complete, partial, or unknown`);
  return value;
}

function validateInput(input: HistoricalEvaluationInput): {
  cutoffs: number[];
  tradeHistory: HistoricalCoverageCompleteness;
  forecastHistory: HistoricalCoverageCompleteness;
} {
  if (!isRecord(input)) throw new TypeError("input must be an object");
  if (!Array.isArray(input.cutoffs) || input.cutoffs.length === 0)
    throw new RangeError("cutoffs must be a non-empty array");
  if (!Array.isArray(input.tradeEvidence))
    throw new TypeError("tradeEvidence must be an array");
  if (!Array.isArray(input.forecastEvidence))
    throw new TypeError("forecastEvidence must be an array");
  if (!isRecord(input.coverage))
    throw new TypeError("coverage metadata is required");

  const cutoffs = [...input.cutoffs];
  for (const cutoff of cutoffs) {
    if (typeof cutoff !== "number" || !Number.isFinite(cutoff))
      throw new TypeError("every cutoff must be finite epoch seconds");
  }
  cutoffs.sort((a, b) => a - b);
  for (let index = 1; index < cutoffs.length; index++) {
    if (cutoffs[index] === cutoffs[index - 1])
      throw new RangeError("evaluation cutoffs must be unique");
  }

  return {
    cutoffs,
    tradeHistory: validateCompleteness(
      input.coverage.tradeHistory,
      "tradeHistory",
    ),
    forecastHistory: validateCompleteness(
      input.coverage.forecastHistory,
      "forecastHistory",
    ),
  };
}

function validateOptions(options: HistoricalEvaluationOptions): void {
  if (!isRecord(options) || !isRecord(options.selection))
    throw new TypeError("selection options are required");
  if (!isRecord(options.selection.trade))
    throw new TypeError("trade selection options are required");
  if (!isRecord(options.selection.forecast))
    throw new TypeError("forecast selection options are required");
}

function toForecasterEvidence(
  trades: readonly AvailableTradeEvidence[],
  forecasts: readonly AvailableForecastEvidence[],
): EliteForecasterEvidence[] {
  const grouped = new Map<
    string,
    {
      forecasterId: string;
      tradeObservations?: ResolvedTradeEvidence[];
      forecastObservations?: BinaryForecastObservation[];
    }
  >();
  for (const trade of trades) {
    const row = grouped.get(trade.forecasterId) ?? {
      forecasterId: trade.forecasterId,
    };
    const tradeObservations = row.tradeObservations ?? [];
    tradeObservations.push({
      id: trade.id,
      rMultiple: trade.rMultiple,
      resolutionTimestamp: trade.resolutionTimestamp,
    });
    row.tradeObservations = tradeObservations;
    grouped.set(trade.forecasterId, row);
  }
  for (const forecast of forecasts) {
    const row = grouped.get(forecast.forecasterId) ?? {
      forecasterId: forecast.forecasterId,
    };
    const forecastObservations = row.forecastObservations ?? [];
    forecastObservations.push({
      id: forecast.id,
      forecasterId: forecast.forecasterId,
      eventId: forecast.eventId,
      probabilityYes: forecast.probabilityYes,
      forecastTimestamp: forecast.forecastTimestamp,
      outcome: forecast.outcome,
      resolutionTimestamp: forecast.resolutionTimestamp,
    });
    row.forecastObservations = forecastObservations;
    grouped.set(forecast.forecasterId, row);
  }
  return [...grouped.values()].sort((a, b) =>
    compareText(a.forecasterId, b.forecasterId),
  );
}

function buildWarnings(
  tradeCompleteness: HistoricalCoverageCompleteness,
  forecastCompleteness: HistoricalCoverageCompleteness,
  availableTrades: number,
  availableForecasts: number,
  forecastMinSampleSize: number,
  assessments: readonly EliteForecasterAssessment[],
): HistoricalEvaluationWarning[] {
  const warnings: HistoricalEvaluationWarning[] = [];
  if (tradeCompleteness !== "complete")
    warnings.push("trade-history-completeness-not-verified");
  if (forecastCompleteness !== "complete")
    warnings.push("forecast-history-completeness-not-verified");

  if (availableTrades === 0) warnings.push("no-trade-evidence-available");
  else if (
    !assessments.some(row => row.trade.trust?.hasSufficientSample === true)
  )
    warnings.push("insufficient-trade-sample");

  if (availableForecasts === 0)
    warnings.push("no-forecast-evidence-available");
  else if (
    !assessments.some(
      row =>
        row.forecast.metrics !== null &&
        row.forecast.metrics.brierScore !== null &&
        row.forecast.metrics.sampleSize >=
          forecastMinSampleSize,
    )
  )
    warnings.push("insufficient-forecast-sample");
  return warnings;
}

/**
 * Evaluates caller-supplied forecaster evidence at unique historical cutoffs.
 *
 * Cutoffs may be supplied in any order and are returned ascending. Duplicate
 * cutoffs are rejected rather than silently evaluated twice. At each cutoff,
 * temporal gating occurs before cutoff-local ID de-duplication and Day 7
 * selection, preventing future resolutions, delayed verification, or future ID
 * conflicts from leaking into the historical result.
 */
export function evaluateForecastersHistorically(
  input: HistoricalEvaluationInput,
  options: HistoricalEvaluationOptions,
): HistoricalEvaluationResult {
  const validated = validateInput(input);
  validateOptions(options);

  const evaluations = validated.cutoffs.map(cutoff => {
    const trade = collectAvailable<AvailableTradeEvidence>(
      "trade",
      input.tradeEvidence as readonly unknown[],
      cutoff,
      sameTradeEvidence,
    );
    const forecast = collectAvailable<AvailableForecastEvidence>(
      "forecast",
      input.forecastEvidence as readonly unknown[],
      cutoff,
      sameForecastEvidence,
    );
    const selection = selectEliteForecasters(
      toForecasterEvidence(trade.available, forecast.available),
      {
        cutoff,
        trade: options.selection.trade,
        forecast: options.selection.forecast,
      },
    );
    const historicalEvidence = [
      ...trade.exclusions,
      ...forecast.exclusions,
    ].sort(compareExclusions);
    const coverage: HistoricalEvaluationCoverage = {
      basis: "caller-supplied-historical-evidence",
      provenance: "not-authenticated",
      tradeHistoryCompleteness: validated.tradeHistory,
      forecastHistoryCompleteness: validated.forecastHistory,
      suppliedTradeObservations: input.tradeEvidence.length,
      suppliedForecastObservations: input.forecastEvidence.length,
      availableTradeObservations: trade.available.length,
      availableForecastObservations: forecast.available.length,
      forecastersEvaluated: selection.assessments.length,
    };

    return {
      cutoff,
      tradeRanking: selection.tradeRanking,
      forecastRanking: selection.forecastRanking,
      eliteSelections: {
        tradeForecasterIds: selection.tradeRanking.map(row => row.forecasterId),
        forecastForecasterIds: selection.forecastRanking.map(
          row => row.forecasterId,
        ),
      },
      forecasters: selection.assessments,
      exclusions: {
        historicalEvidence,
        selectionInputs: selection.inputExclusions,
      },
      coverage,
      warnings: buildWarnings(
        validated.tradeHistory,
        validated.forecastHistory,
        trade.available.length,
        forecast.available.length,
        options.selection.forecast.minSampleSize,
        selection.assessments,
      ),
    } satisfies HistoricalCutoffEvaluation;
  });

  return {
    coverage: {
      basis: "caller-supplied-historical-evidence",
      provenance: "not-authenticated",
      tradeHistoryCompleteness: validated.tradeHistory,
      forecastHistoryCompleteness: validated.forecastHistory,
    },
    evaluations,
  };
}
