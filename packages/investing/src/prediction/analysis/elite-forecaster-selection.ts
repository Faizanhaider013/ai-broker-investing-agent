/**
 * Pure elite-forecaster selection over explicitly supplied evidence.
 *
 * Trade performance and forecast accuracy are intentionally ranked separately:
 * TRUST and Brier Score measure different evidence and are not combined by an
 * invented weighting formula. This module performs no database or network I/O.
 * All evidence is caller-supplied. The selector cannot authenticate provenance
 * or guarantee historical completeness; callers must ensure evidence is
 * verified, complete for the intended evaluation, and was available by the
 * inclusive cutoff.
 */

import {
  computeBinaryForecastMetrics,
  type BinaryForecastMetricsResult,
  type BinaryForecastObservation,
} from "./binary-forecast-metrics";
import {
  computeForecasterTrustScore,
  DEFAULT_MIN_SAMPLE_SIZE,
  type ForecasterTrustScore,
} from "./trust-score";

export const DEFAULT_ELITE_TRADE_TOP_FRACTION = 0.1;
export const DEFAULT_ELITE_BRIER_SCORE_THRESHOLD = 0.15;

/** One verified resolved-trade R-multiple supplied by the caller. */
export interface ResolvedTradeEvidence {
  id: string;
  rMultiple: number;
  /** Epoch seconds at which the trade outcome became known. */
  resolutionTimestamp: number;
}

/** Evidence supplied for one stable forecaster identity. */
export interface EliteForecasterEvidence {
  forecasterId: string;
  tradeObservations?: readonly ResolvedTradeEvidence[];
  forecastObservations?: readonly BinaryForecastObservation[];
}

export interface EliteTradeSelectionOptions {
  /** Defaults to the existing TRUST reliability minimum of 25. */
  minSampleSize?: number;
  /**
   * Defaults to the roadmap's top 10%; must be in `(0, 1]`. Cohort size is
   * rounded up, so any non-empty eligible cohort selects at least one candidate.
   * This discrete policy cannot represent an exact percentile in small cohorts.
   */
  topFraction?: number;
  /** Optional independent floor applied after TRUST is computed. */
  minimumTrustScore?: number;
  /** Passed to the existing TRUST utility. Defaults to sample stddev (`1`). */
  ddof?: 0 | 1;
}

export interface EliteForecastSelectionOptions {
  /** Required resolved-forecast minimum; the roadmap does not define a default. */
  minSampleSize: number;
  /** Strict upper bound; defaults to the roadmap's Brier Score `< 0.15`. */
  brierScoreThreshold?: number;
}

export interface EliteForecasterSelectionOptions {
  /** Inclusive epoch-second evaluation cutoff for both evidence categories. */
  cutoff: number;
  trade: EliteTradeSelectionOptions;
  forecast: EliteForecastSelectionOptions;
}

export type TradeEvidenceExclusionReason =
  | "malformed-observation"
  | "invalid-id"
  | "invalid-r-multiple"
  | "invalid-resolution-timestamp"
  | "after-cutoff"
  | "duplicate-id"
  | "conflicting-duplicate-id";

export interface TradeEvidenceExclusion {
  observationId: string | null;
  reasons: TradeEvidenceExclusionReason[];
}

export type TradeEligibilityReason =
  | "missing-evidence"
  | "invalid-evidence"
  | "insufficient-sample"
  | "undefined-trust-score"
  | "below-minimum-trust-score"
  | "outside-top-fraction";

export type ForecastEligibilityReason =
  | "missing-evidence"
  | "invalid-evidence"
  | "insufficient-sample"
  | "undefined-brier-score"
  | "brier-score-not-below-threshold";

export interface TradeEligibilityAssessment {
  eligible: boolean;
  reasons: TradeEligibilityReason[];
  trust: ForecasterTrustScore | null;
  exclusions: TradeEvidenceExclusion[];
}

export interface ForecastEligibilityAssessment {
  eligible: boolean;
  reasons: ForecastEligibilityReason[];
  metrics: BinaryForecastMetricsResult | null;
}

export interface EliteForecasterAssessment {
  forecasterId: string;
  trade: TradeEligibilityAssessment;
  forecast: ForecastEligibilityAssessment;
}

export interface TradeEliteRankingEntry {
  rank: number;
  forecasterId: string;
  trustScore: number;
  sampleSize: number;
  trust: ForecasterTrustScore;
}

export interface ForecastEliteRankingEntry {
  rank: number;
  forecasterId: string;
  brierScore: number;
  sampleSize: number;
  metrics: BinaryForecastMetricsResult;
}

export type ForecasterInputExclusionReason =
  | "malformed-evidence"
  | "invalid-forecaster-id"
  | "duplicate-forecaster"
  | "conflicting-duplicate-forecaster";

export interface ForecasterInputExclusion {
  forecasterId: string | null;
  reasons: ForecasterInputExclusionReason[];
}

export interface EliteForecasterSelectionResult {
  cutoff: number;
  thresholds: {
    tradeMinSampleSize: number;
    tradeTopFraction: number;
    minimumTrustScore: number | null;
    forecastMinSampleSize: number;
    brierScoreThreshold: number;
  };
  /** Descending TRUST order; ties break by forecaster ID. */
  tradeRanking: TradeEliteRankingEntry[];
  /** Ascending Brier order; ties break by forecaster ID. */
  forecastRanking: ForecastEliteRankingEntry[];
  /** One assessment for every accepted unique forecaster identity. */
  assessments: EliteForecasterAssessment[];
  inputExclusions: ForecasterInputExclusion[];
}

interface ValidEvidence extends EliteForecasterEvidence {}

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

function sameTradeObservation(a: unknown, b: unknown): boolean {
  if (!isRecord(a) || !isRecord(b)) return a === b;
  return (
    a.id === b.id &&
    a.rMultiple === b.rMultiple &&
    a.resolutionTimestamp === b.resolutionTimestamp
  );
}

function sameForecastObservation(a: unknown, b: unknown): boolean {
  if (!isRecord(a) || !isRecord(b)) return a === b;
  return (
    a.id === b.id &&
    a.forecasterId === b.forecasterId &&
    a.eventId === b.eventId &&
    a.probabilityYes === b.probabilityYes &&
    a.forecastTimestamp === b.forecastTimestamp &&
    a.outcome === b.outcome &&
    a.resolutionTimestamp === b.resolutionTimestamp
  );
}

function sameOptionalObservationMultiset(
  a: unknown,
  b: unknown,
  sameItem: (left: unknown, right: unknown) => boolean,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === b;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
    return false;

  // Match each item exactly once. This makes comparison independent of array
  // order without collapsing duplicates or discarding materially different
  // observations that happen to share an ID.
  const matched = new Array<boolean>(b.length).fill(false);
  for (const item of a) {
    const index = b.findIndex(
      (candidate, candidateIndex) =>
        !matched[candidateIndex] && sameItem(item, candidate),
    );
    if (index === -1) return false;
    matched[index] = true;
  }
  return true;
}

function sameEvidence(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return (
    a.forecasterId === b.forecasterId &&
    sameOptionalObservationMultiset(
      a.tradeObservations,
      b.tradeObservations,
      sameTradeObservation,
    ) &&
    sameOptionalObservationMultiset(
      a.forecastObservations,
      b.forecastObservations,
      sameForecastObservation,
    )
  );
}

function compareTradeExclusions(
  a: TradeEvidenceExclusion,
  b: TradeEvidenceExclusion,
): number {
  return (
    compareText(a.observationId ?? "", b.observationId ?? "") ||
    compareText(a.reasons.join("\u0000"), b.reasons.join("\u0000"))
  );
}

function assessTradeEvidence(
  value: unknown,
  cutoff: number,
  minSampleSize: number,
  ddof: 0 | 1,
): TradeEligibilityAssessment {
  if (value === undefined)
    return {
      eligible: false,
      reasons: ["missing-evidence"],
      trust: null,
      exclusions: [],
    };
  if (!Array.isArray(value))
    return {
      eligible: false,
      reasons: ["invalid-evidence"],
      trust: null,
      exclusions: [],
    };

  const rowsById = new Map<string, Record<string, unknown>[]>();
  for (const item of value as readonly unknown[]) {
    if (!isRecord(item) || !isIdentity(item.id)) continue;
    const group = rowsById.get(item.id) ?? [];
    group.push(item);
    rowsById.set(item.id, group);
  }
  const conflictingIds = new Set<string>();
  for (const [id, group] of rowsById) {
    if (!group.every(row => sameTradeObservation(row, group[0])))
      conflictingIds.add(id);
  }

  const exclusions: TradeEvidenceExclusion[] = [];
  const valid: ResolvedTradeEvidence[] = [];
  for (const item of value as readonly unknown[]) {
    if (!isRecord(item)) {
      exclusions.push({
        observationId: null,
        reasons: ["malformed-observation"],
      });
      continue;
    }
    const reasons: TradeEvidenceExclusionReason[] = [];
    if (!isIdentity(item.id)) reasons.push("invalid-id");
    else if (conflictingIds.has(item.id))
      reasons.push("conflicting-duplicate-id");
    if (typeof item.rMultiple !== "number" || !Number.isFinite(item.rMultiple))
      reasons.push("invalid-r-multiple");
    if (
      typeof item.resolutionTimestamp !== "number" ||
      !Number.isFinite(item.resolutionTimestamp)
    )
      reasons.push("invalid-resolution-timestamp");
    if (
      reasons.length === 0 &&
      (item.resolutionTimestamp as number) > cutoff
    )
      reasons.push("after-cutoff");

    if (reasons.length > 0) {
      exclusions.push({
        observationId: diagnosticIdentity(item.id),
        reasons: [...reasons].sort(),
      });
    } else {
      valid.push({
        id: item.id as string,
        rMultiple: item.rMultiple as number,
        resolutionTimestamp: item.resolutionTimestamp as number,
      });
    }
  }

  valid.sort(
    (a, b) =>
      compareText(a.id, b.id) ||
      a.resolutionTimestamp - b.resolutionTimestamp ||
      a.rMultiple - b.rMultiple,
  );
  const unique: ResolvedTradeEvidence[] = [];
  for (let index = 0; index < valid.length; ) {
    const row = valid[index];
    let next = index + 1;
    while (next < valid.length && valid[next].id === row.id) next++;
    unique.push(row);
    for (let duplicate = index + 1; duplicate < next; duplicate++)
      exclusions.push({ observationId: row.id, reasons: ["duplicate-id"] });
    index = next;
  }

  exclusions.sort(compareTradeExclusions);
  const trust = computeForecasterTrustScore(
    unique.map(row => row.rMultiple),
    { minSampleSize, ddof },
  );
  const reasons: TradeEligibilityReason[] = [];
  if (!trust.hasSufficientSample) reasons.push("insufficient-sample");
  if (!trust.isDefined) reasons.push("undefined-trust-score");
  return { eligible: false, reasons, trust, exclusions };
}

function assessForecastEvidence(
  value: unknown,
  forecasterId: string,
  cutoff: number,
  minSampleSize: number,
): ForecastEligibilityAssessment {
  if (value === undefined)
    return {
      eligible: false,
      reasons: ["missing-evidence"],
      metrics: null,
    };
  if (!Array.isArray(value))
    return {
      eligible: false,
      reasons: ["invalid-evidence"],
      metrics: null,
    };
  const metrics = computeBinaryForecastMetrics(
    value as readonly BinaryForecastObservation[],
    { cutoff, expectedForecasterId: forecasterId },
  );
  const reasons: ForecastEligibilityReason[] = [];
  if (metrics.sampleSize < minSampleSize) reasons.push("insufficient-sample");
  if (metrics.brierScore === null) reasons.push("undefined-brier-score");
  return { eligible: false, reasons, metrics };
}

function validateOptions(options: EliteForecasterSelectionOptions): {
  cutoff: number;
  tradeMinSampleSize: number;
  tradeTopFraction: number;
  minimumTrustScore: number | undefined;
  ddof: 0 | 1;
  forecastMinSampleSize: number;
  brierScoreThreshold: number;
} {
  if (!isRecord(options)) throw new TypeError("options must be an object");
  if (typeof options.cutoff !== "number" || !Number.isFinite(options.cutoff))
    throw new TypeError("cutoff must be finite epoch seconds");
  if (!isRecord(options.trade)) throw new TypeError("trade options are required");
  if (!isRecord(options.forecast))
    throw new TypeError("forecast options are required");

  const tradeOptions = options.trade as EliteTradeSelectionOptions;
  const forecastOptions = options.forecast as EliteForecastSelectionOptions;

  const tradeMinSampleSize =
    tradeOptions.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;
  const tradeTopFraction =
    tradeOptions.topFraction ?? DEFAULT_ELITE_TRADE_TOP_FRACTION;
  const minimumTrustScore = tradeOptions.minimumTrustScore;
  const ddof = tradeOptions.ddof ?? 1;
  const forecastMinSampleSize = forecastOptions.minSampleSize;
  const brierScoreThreshold =
    forecastOptions.brierScoreThreshold ??
    DEFAULT_ELITE_BRIER_SCORE_THRESHOLD;

  if (!Number.isInteger(tradeMinSampleSize) || tradeMinSampleSize < 1)
    throw new RangeError("trade minSampleSize must be a positive integer");
  if (
    typeof tradeTopFraction !== "number" ||
    !Number.isFinite(tradeTopFraction) ||
    tradeTopFraction <= 0 ||
    tradeTopFraction > 1
  )
    throw new RangeError("trade topFraction must be in (0, 1]");
  if (
    minimumTrustScore !== undefined &&
    (typeof minimumTrustScore !== "number" ||
      !Number.isFinite(minimumTrustScore))
  )
    throw new TypeError("minimumTrustScore must be finite when supplied");
  if (ddof !== 0 && ddof !== 1) throw new RangeError("ddof must be 0 or 1");
  if (!Number.isInteger(forecastMinSampleSize) || forecastMinSampleSize < 1)
    throw new RangeError("forecast minSampleSize must be a positive integer");
  if (
    typeof brierScoreThreshold !== "number" ||
    !Number.isFinite(brierScoreThreshold) ||
    brierScoreThreshold < 0 ||
    brierScoreThreshold > 1
  )
    throw new RangeError("brierScoreThreshold must be in [0, 1]");

  return {
    cutoff: options.cutoff,
    tradeMinSampleSize,
    tradeTopFraction,
    minimumTrustScore,
    ddof,
    forecastMinSampleSize,
    brierScoreThreshold,
  };
}

/**
 * Selects elite forecasters in two non-combined ranking categories.
 *
 * TRUST candidates must have a defined score and sufficient resolved trades,
 * then fall inside the configured top fraction (and optional score floor).
 * The top-fraction cohort count uses `Math.ceil`; a positive fraction therefore
 * selects at least one member of every non-empty eligible cohort, and small
 * cohorts will not necessarily represent the configured percentile exactly.
 * Forecast candidates must have enough valid resolved forecasts and a Brier
 * Score strictly below the configured threshold. Ties break by stable ID.
 *
 * Evidence is supplied and verified by the caller. This selector cannot
 * authenticate its provenance or prove that history is complete. Callers are
 * responsible for supplying evidence that is complete for their intended
 * evaluation and was available by `cutoff`. Trade-based TRUST and forecast-based
 * Brier evidence remain separate rankings and are never combined here.
 */
export function selectEliteForecasters(
  evidence: readonly EliteForecasterEvidence[],
  options: EliteForecasterSelectionOptions,
): EliteForecasterSelectionResult {
  if (!Array.isArray(evidence))
    throw new TypeError("evidence must be an array");
  const config = validateOptions(options);
  const inputExclusions: ForecasterInputExclusion[] = [];

  const rowsByForecaster = new Map<string, Record<string, unknown>[]>();
  for (const item of evidence as readonly unknown[]) {
    if (!isRecord(item)) {
      inputExclusions.push({ forecasterId: null, reasons: ["malformed-evidence"] });
      continue;
    }
    if (!isIdentity(item.forecasterId)) {
      inputExclusions.push({
        forecasterId: diagnosticIdentity(item.forecasterId),
        reasons: ["invalid-forecaster-id"],
      });
      continue;
    }
    const group = rowsByForecaster.get(item.forecasterId) ?? [];
    group.push(item);
    rowsByForecaster.set(item.forecasterId, group);
  }

  const accepted: ValidEvidence[] = [];
  for (const forecasterId of [...rowsByForecaster.keys()].sort()) {
    const group = rowsByForecaster.get(forecasterId) as Record<string, unknown>[];
    if (!group.every(item => sameEvidence(item, group[0]))) {
      for (const _item of group)
        inputExclusions.push({
          forecasterId,
          reasons: ["conflicting-duplicate-forecaster"],
        });
      continue;
    }
    accepted.push(group[0] as unknown as ValidEvidence);
    for (let index = 1; index < group.length; index++)
      inputExclusions.push({
        forecasterId,
        reasons: ["duplicate-forecaster"],
      });
  }

  inputExclusions.sort(
    (a, b) =>
      compareText(a.forecasterId ?? "", b.forecasterId ?? "") ||
      compareText(a.reasons.join("\u0000"), b.reasons.join("\u0000")),
  );
  const assessments: EliteForecasterAssessment[] = accepted.map(item => ({
    forecasterId: item.forecasterId,
    trade: assessTradeEvidence(
      item.tradeObservations,
      config.cutoff,
      config.tradeMinSampleSize,
      config.ddof,
    ),
    forecast: assessForecastEvidence(
      item.forecastObservations,
      item.forecasterId,
      config.cutoff,
      config.forecastMinSampleSize,
    ),
  }));

  const tradeCandidates = assessments
    .filter(
      assessment =>
        assessment.trade.trust?.reliable === true &&
        assessment.trade.trust.score !== null,
    )
    .sort(
      (a, b) =>
        (b.trade.trust?.score as number) -
          (a.trade.trust?.score as number) ||
        compareText(a.forecasterId, b.forecasterId),
    );
  const eliteTradeCount = Math.ceil(
    tradeCandidates.length * config.tradeTopFraction,
  );
  const tradeRanking: TradeEliteRankingEntry[] = [];
  tradeCandidates.forEach((assessment, index) => {
    const trust = assessment.trade.trust as ForecasterTrustScore & {
      score: number;
    };
    if (index >= eliteTradeCount)
      assessment.trade.reasons.push("outside-top-fraction");
    if (
      config.minimumTrustScore !== undefined &&
      trust.score < config.minimumTrustScore
    )
      assessment.trade.reasons.push("below-minimum-trust-score");
    assessment.trade.reasons.sort();
    assessment.trade.eligible = assessment.trade.reasons.length === 0;
    if (assessment.trade.eligible)
      tradeRanking.push({
        rank: index + 1,
        forecasterId: assessment.forecasterId,
        trustScore: trust.score,
        sampleSize: trust.sampleSize,
        trust,
      });
  });

  const forecastRanking: ForecastEliteRankingEntry[] = [];
  for (const assessment of assessments) {
    const { metrics } = assessment.forecast;
    if (
      metrics !== null &&
      metrics.brierScore !== null &&
      metrics.sampleSize >= config.forecastMinSampleSize &&
      metrics.brierScore >= config.brierScoreThreshold
    )
      assessment.forecast.reasons.push("brier-score-not-below-threshold");
    assessment.forecast.reasons.sort();
    assessment.forecast.eligible = assessment.forecast.reasons.length === 0;
    if (
      assessment.forecast.eligible &&
      metrics !== null &&
      metrics.brierScore !== null
    )
      forecastRanking.push({
        rank: 0,
        forecasterId: assessment.forecasterId,
        brierScore: metrics.brierScore,
        sampleSize: metrics.sampleSize,
        metrics,
      });
  }
  forecastRanking.sort(
    (a, b) =>
      a.brierScore - b.brierScore ||
      compareText(a.forecasterId, b.forecasterId),
  );
  forecastRanking.forEach((entry, index) => {
    entry.rank = index + 1;
  });
  assessments.sort((a, b) => compareText(a.forecasterId, b.forecasterId));

  return {
    cutoff: config.cutoff,
    thresholds: {
      tradeMinSampleSize: config.tradeMinSampleSize,
      tradeTopFraction: config.tradeTopFraction,
      minimumTrustScore: config.minimumTrustScore ?? null,
      forecastMinSampleSize: config.forecastMinSampleSize,
      brierScoreThreshold: config.brierScoreThreshold,
    },
    tradeRanking,
    forecastRanking,
    assessments,
    inputExclusions,
  };
}
