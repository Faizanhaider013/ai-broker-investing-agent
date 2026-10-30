/**
 * Pure Brier Score and calibration metrics for caller-supplied binary forecasts.
 *
 * This module deliberately has no repository, database, market-snapshot, or
 * resolution-label integration. The application does not currently persist a
 * complete immutable history that joins forecasts to authoritative outcomes.
 * Callers must therefore supply already-joined observations and remain
 * responsible for their provenance, completeness, and historical immutability.
 *
 * All timestamps are epoch seconds. A valid observation must have been made
 * strictly before its authoritative binary outcome became known. Both
 * timestamps must be at or before the caller's inclusive evaluation cutoff.
 * The function never reads the wall clock, so historical and current
 * evaluations are reproducible and cannot silently include future resolutions.
 */

/** One caller-supplied, already-resolved binary P(YES) forecast. */
export interface BinaryForecastObservation {
  /** Stable, non-empty identity used to detect duplicate observations. */
  id: string;
  /** Stable identity of the forecaster being evaluated. */
  forecasterId: string;
  /** Stable identity of the binary event. */
  eventId: string;
  /** Forecast P(YES), from 0 through 1 inclusive. */
  probabilityYes: number;
  /** Epoch seconds at which the forecast was made. */
  forecastTimestamp: number;
  /** Authoritative binary result: `1` for YES, `0` for NO. */
  outcome: 0 | 1;
  /** Epoch seconds at which the authoritative result became known. */
  resolutionTimestamp: number;
}

/** Options for {@link computeBinaryForecastMetrics}. */
export interface BinaryForecastMetricsOptions {
  /** Inclusive evaluation cutoff in epoch seconds. */
  cutoff: number;
  /** If supplied, observations for any other forecaster are excluded. */
  expectedForecasterId?: string;
}

/** Why a caller-supplied observation was not scored. */
export type BinaryForecastExclusionReason =
  | "malformed-observation"
  | "invalid-id"
  | "invalid-forecaster-id"
  | "invalid-event-id"
  | "invalid-probability"
  | "invalid-outcome"
  | "invalid-forecast-timestamp"
  | "invalid-resolution-timestamp"
  | "forecast-not-before-resolution"
  /** The forecast, resolution, or both postdate the inclusive evaluation cutoff. */
  | "after-cutoff"
  | "forecaster-mismatch"
  | "mixed-forecasters"
  | "duplicate-id"
  | "conflicting-duplicate-id"
  | "duplicate-event";

/** Deterministic diagnostic for one excluded input row. */
export interface BinaryForecastExclusion {
  observationId: string | null;
  forecasterId: string | null;
  eventId: string | null;
  reasons: BinaryForecastExclusionReason[];
}

/** One of ten fixed equal-width probability bins. */
export interface BinaryCalibrationBin {
  /** Zero-based bin number. */
  index: number;
  /** Inclusive lower probability bound. */
  lowerBound: number;
  /** Upper probability bound; inclusive only for the final bin. */
  upperBound: number;
  upperBoundInclusive: boolean;
  count: number;
  /** Mean P(YES), or `null` when the bin is empty. */
  meanProbability: number | null;
  /** Fraction of outcomes equal to YES, or `null` when empty. */
  observedFrequency: number | null;
}

/** Result of {@link computeBinaryForecastMetrics}. */
export interface BinaryForecastMetricsResult {
  /** Explicitly does not claim repository-backed historical coverage. */
  coverage: "caller-supplied-observations";
  /** The one scored forecaster, if established from the options or valid rows. */
  forecasterId: string | null;
  /** Inclusive evaluation cutoff applied to every observation. */
  cutoff: number;
  /** Mean `(probabilityYes - outcome) ** 2`, or `null` for no valid sample. */
  brierScore: number | null;
  sampleSize: number;
  calibrationBins: BinaryCalibrationBin[];
  exclusions: BinaryForecastExclusion[];
}

interface Candidate extends BinaryForecastObservation {}

const BIN_COUNT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value
  );
}

function diagnosticIdentity(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function exclusion(
  observation: unknown,
  reasons: BinaryForecastExclusionReason[],
): BinaryForecastExclusion {
  const row = isRecord(observation) ? observation : undefined;
  return {
    observationId: diagnosticIdentity(row?.id),
    forecasterId: diagnosticIdentity(row?.forecasterId),
    eventId: diagnosticIdentity(row?.eventId),
    reasons: [...reasons].sort(),
  };
}

function sameObservation(a: Candidate, b: Candidate): boolean {
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

function sameRawObservation(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    compareText(a.forecasterId, b.forecasterId) ||
    compareText(a.eventId, b.eventId) ||
    a.forecastTimestamp - b.forecastTimestamp ||
    a.resolutionTimestamp - b.resolutionTimestamp ||
    compareText(a.id, b.id) ||
    a.probabilityYes - b.probabilityYes ||
    a.outcome - b.outcome
  );
}

function compareExclusions(
  a: BinaryForecastExclusion,
  b: BinaryForecastExclusion,
): number {
  return (
    compareText(a.observationId ?? "", b.observationId ?? "") ||
    compareText(a.forecasterId ?? "", b.forecasterId ?? "") ||
    compareText(a.eventId ?? "", b.eventId ?? "") ||
    compareText(a.reasons.join("\u0000"), b.reasons.join("\u0000"))
  );
}

function buildCalibrationBins(
  observations: readonly Candidate[],
): BinaryCalibrationBin[] {
  const groups = Array.from({ length: BIN_COUNT }, () => ({
    count: 0,
    probabilitySum: 0,
    outcomeSum: 0,
  }));

  for (const observation of observations) {
    const index = Math.min(
      BIN_COUNT - 1,
      Math.floor(observation.probabilityYes * BIN_COUNT),
    );
    const group = groups[index];
    group.count++;
    group.probabilitySum += observation.probabilityYes;
    group.outcomeSum += observation.outcome;
  }

  return groups.map((group, index) => ({
    index,
    lowerBound: index / BIN_COUNT,
    upperBound: (index + 1) / BIN_COUNT,
    upperBoundInclusive: index === BIN_COUNT - 1,
    count: group.count,
    meanProbability:
      group.count === 0 ? null : group.probabilitySum / group.count,
    observedFrequency:
      group.count === 0 ? null : group.outcomeSum / group.count,
  }));
}

/**
 * Computes Brier Score and calibration bins from caller-supplied observations.
 *
 * Runtime validation is conservative: invalid rows are reported, exact repeated
 * IDs are counted once, conflicting IDs are all rejected, and multiple distinct
 * forecasts for one `(forecasterId, eventId)` are all rejected rather than
 * implicitly selecting a forecast. Mixed forecasters are never aggregated.
 * Results and diagnostics are sorted deterministically and inputs are not
 * mutated.
 *
 * This function cannot verify that an outcome label is authoritative, that its
 * timestamp is truthful, that forecasts were stored immutably, or that history
 * is complete. Those remain caller responsibilities.
 */
export function computeBinaryForecastMetrics(
  observations: readonly BinaryForecastObservation[],
  options: BinaryForecastMetricsOptions,
): BinaryForecastMetricsResult {
  if (!Array.isArray(observations))
    throw new TypeError("observations must be an array");
  if (!isRecord(options)) throw new TypeError("options must be an object");

  const cutoff = options.cutoff;
  if (
    (typeof cutoff !== "number" || !Number.isFinite(cutoff))
  )
    throw new TypeError("cutoff must be finite epoch seconds");

  const expectedForecasterId = options.expectedForecasterId;
  if (
    expectedForecasterId !== undefined &&
    !isIdentity(expectedForecasterId)
  )
    throw new TypeError("expectedForecasterId must be trimmed non-empty text");

  let candidates: Candidate[] = [];
  const exclusions: BinaryForecastExclusion[] = [];

  // Detect conflicting stable IDs before any other eligibility filter. A bad,
  // mismatched, or post-cutoff row must not let another record carrying the
  // same ID score as though the conflict did not exist.
  const rawRowsById = new Map<string, Record<string, unknown>[]>();
  for (const observation of observations as readonly unknown[]) {
    if (!isRecord(observation) || !isIdentity(observation.id)) continue;
    const group = rawRowsById.get(observation.id) ?? [];
    group.push(observation);
    rawRowsById.set(observation.id, group);
  }
  const conflictingIds = new Set<string>();
  for (const [id, group] of rawRowsById) {
    if (!group.every(row => sameRawObservation(row, group[0])))
      conflictingIds.add(id);
  }

  for (const observation of observations as readonly unknown[]) {
    if (!isRecord(observation)) {
      exclusions.push(exclusion(observation, ["malformed-observation"]));
      continue;
    }

    const reasons: BinaryForecastExclusionReason[] = [];
    if (!isIdentity(observation.id)) reasons.push("invalid-id");
    else if (conflictingIds.has(observation.id))
      reasons.push("conflicting-duplicate-id");
    if (!isIdentity(observation.forecasterId))
      reasons.push("invalid-forecaster-id");
    if (!isIdentity(observation.eventId)) reasons.push("invalid-event-id");
    if (
      typeof observation.probabilityYes !== "number" ||
      !Number.isFinite(observation.probabilityYes) ||
      observation.probabilityYes < 0 ||
      observation.probabilityYes > 1
    )
      reasons.push("invalid-probability");
    if (observation.outcome !== 0 && observation.outcome !== 1)
      reasons.push("invalid-outcome");
    if (
      typeof observation.forecastTimestamp !== "number" ||
      !Number.isFinite(observation.forecastTimestamp)
    )
      reasons.push("invalid-forecast-timestamp");
    if (
      typeof observation.resolutionTimestamp !== "number" ||
      !Number.isFinite(observation.resolutionTimestamp)
    )
      reasons.push("invalid-resolution-timestamp");

    if (reasons.length === 0) {
      const candidate = observation as unknown as Candidate;
      if (candidate.forecastTimestamp >= candidate.resolutionTimestamp)
        reasons.push("forecast-not-before-resolution");
      if (
        (candidate.forecastTimestamp > cutoff ||
          candidate.resolutionTimestamp > cutoff)
      )
        reasons.push("after-cutoff");
      if (
        expectedForecasterId !== undefined &&
        candidate.forecasterId !== expectedForecasterId
      )
        reasons.push("forecaster-mismatch");
    }

    if (reasons.length > 0) exclusions.push(exclusion(observation, reasons));
    else candidates.push({ ...(observation as unknown as Candidate) });
  }

  candidates.sort(compareCandidates);

  // A repeated ID is either one exact observation (count once) or an ambiguous
  // conflict (reject every row carrying that ID).
  const afterIds: Candidate[] = [];
  const rowsById = new Map<string, Candidate[]>();
  for (const row of candidates) {
    const group = rowsById.get(row.id) ?? [];
    group.push(row);
    rowsById.set(row.id, group);
  }
  for (const id of [...rowsById.keys()].sort()) {
    const group = rowsById.get(id) as Candidate[];
    group.sort(compareCandidates);
    if (group.every(row => sameObservation(row, group[0]))) {
      afterIds.push(group[0]);
      for (let index = 1; index < group.length; index++)
        exclusions.push(exclusion(group[index], ["duplicate-id"]));
    } else {
      for (const row of group)
        exclusions.push(exclusion(row, ["conflicting-duplicate-id"]));
    }
  }
  candidates = afterIds.sort(compareCandidates);

  // Without an explicit expected identity, any mixed set is ambiguous. Reject
  // the entire remaining set rather than choosing a forecaster implicitly.
  if (
    expectedForecasterId === undefined &&
    new Set(candidates.map(row => row.forecasterId)).size > 1
  ) {
    for (const row of candidates)
      exclusions.push(exclusion(row, ["mixed-forecasters"]));
    candidates = [];
  }

  // The initial contract permits at most one distinct forecast per event. This
  // avoids silently treating updates/retries as independent evidence.
  const eventCounts = new Map<string, number>();
  for (const row of candidates) {
    const key = `${row.forecasterId}\u0000${row.eventId}`;
    eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
  }
  const included: Candidate[] = [];
  for (const row of candidates) {
    const key = `${row.forecasterId}\u0000${row.eventId}`;
    if ((eventCounts.get(key) ?? 0) > 1)
      exclusions.push(exclusion(row, ["duplicate-event"]));
    else included.push(row);
  }

  included.sort(compareCandidates);
  exclusions.sort(compareExclusions);

  const sampleSize = included.length;
  const brierScore =
    sampleSize === 0
      ? null
      : included.reduce(
          (sum, row) => sum + (row.probabilityYes - row.outcome) ** 2,
          0,
        ) / sampleSize;

  return {
    coverage: "caller-supplied-observations",
    forecasterId:
      expectedForecasterId ??
      (included.length > 0 ? included[0].forecasterId : null),
    cutoff,
    brierScore,
    sampleSize,
    calibrationBins: buildCalibrationBins(included),
    exclusions,
  };
}
