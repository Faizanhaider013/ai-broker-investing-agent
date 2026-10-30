import { describe, expect, it } from "vitest";
import {
  evaluateForecastersHistorically,
  type HistoricalEvaluationInput,
  type HistoricalEvaluationOptions,
  type HistoricalForecastEvidence,
  type HistoricalTradeEvidence,
} from "../src/prediction/analysis/historical-forecaster-evaluation";

// All fixtures in this file are synthetic mechanics tests. They do not measure
// or claim real-world historical or predictive performance.
function trade(
  overrides: Partial<HistoricalTradeEvidence> = {},
): HistoricalTradeEvidence {
  return {
    id: "trade-1",
    forecasterId: "alpha",
    rMultiple: 1,
    resolutionTimestamp: 80,
    availabilityTimestamp: 100,
    ...overrides,
  };
}

function forecast(
  overrides: Partial<HistoricalForecastEvidence> = {},
): HistoricalForecastEvidence {
  return {
    id: "forecast-1",
    forecasterId: "alpha",
    eventId: "event-1",
    probabilityYes: 0.9,
    forecastTimestamp: 50,
    outcome: 1,
    resolutionTimestamp: 90,
    availabilityTimestamp: 110,
    ...overrides,
  };
}

function input(
  overrides: Partial<HistoricalEvaluationInput> = {},
): HistoricalEvaluationInput {
  return {
    cutoffs: [200],
    tradeEvidence: [],
    forecastEvidence: [],
    coverage: { tradeHistory: "complete", forecastHistory: "complete" },
    ...overrides,
  };
}

function options(
  overrides: Partial<HistoricalEvaluationOptions> = {},
): HistoricalEvaluationOptions {
  return {
    selection: {
      trade: { minSampleSize: 2, topFraction: 1, ddof: 0 },
      forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
    },
    ...overrides,
  };
}

describe("evaluateForecastersHistorically", () => {
  it("evaluates growing TRUST and Brier samples at sorted historical cutoffs", () => {
    const result = evaluateForecastersHistorically(
      input({
        cutoffs: [300, 100, 170],
        tradeEvidence: [
          trade(),
          trade({
            id: "trade-2",
            rMultiple: 0,
            resolutionTimestamp: 150,
            availabilityTimestamp: 160,
          }),
          trade({
            id: "trade-3",
            rMultiple: -0.5,
            resolutionTimestamp: 240,
            availabilityTimestamp: 250,
          }),
        ],
        forecastEvidence: [
          forecast(),
          forecast({
            id: "forecast-2",
            eventId: "event-2",
            probabilityYes: 0.2,
            outcome: 0,
            resolutionTimestamp: 150,
            availabilityTimestamp: 170,
          }),
          forecast({
            id: "forecast-3",
            eventId: "event-3",
            probabilityYes: 0.6,
            outcome: 1,
            resolutionTimestamp: 240,
            availabilityTimestamp: 260,
          }),
        ],
      }),
      options(),
    );

    expect(result.evaluations.map(row => row.cutoff)).toEqual([100, 170, 300]);
    expect(result.evaluations.map(row =>
      row.forecasters[0]?.trade.trust?.sampleSize ?? 0
    )).toEqual([1, 2, 3]);
    expect(result.evaluations.map(row =>
      row.forecasters[0]?.forecast.metrics?.sampleSize ?? 0
    )).toEqual([0, 2, 3]);
    expect(result.evaluations[1].forecasters[0].trade.trust?.score)
      .toBeCloseTo(Math.sqrt(2), 12);
    expect(result.evaluations[1].forecasters[0].forecast.metrics?.brierScore)
      .toBeCloseTo(0.025, 12);
    expect(result.evaluations[1].eliteSelections).toEqual({
      tradeForecasterIds: ["alpha"],
      forecastForecasterIds: ["alpha"],
    });
  });

  it("waits for evidence availability even after the underlying result resolves", () => {
    const result = evaluateForecastersHistorically(
      input({
        cutoffs: [110, 120],
        tradeEvidence: [trade({ resolutionTimestamp: 100, availabilityTimestamp: 120 })],
        forecastEvidence: [
          forecast({ resolutionTimestamp: 100, availabilityTimestamp: 120 }),
        ],
      }),
      options(),
    );

    expect(result.evaluations[0].coverage.availableTradeObservations).toBe(0);
    expect(result.evaluations[0].coverage.availableForecastObservations).toBe(0);
    expect(result.evaluations[0].exclusions.historicalEvidence.every(row =>
      row.reasons.includes("availability-after-cutoff")
    )).toBe(true);
    expect(result.evaluations[1].coverage.availableTradeObservations).toBe(1);
    expect(result.evaluations[1].coverage.availableForecastObservations).toBe(1);
  });

  it("excludes future-resolved trades and forecasts from earlier cutoffs", () => {
    const result = evaluateForecastersHistorically(
      input({
        cutoffs: [100],
        tradeEvidence: [
          trade({ resolutionTimestamp: 101, availabilityTimestamp: 101 }),
        ],
        forecastEvidence: [
          forecast({ resolutionTimestamp: 101, availabilityTimestamp: 101 }),
        ],
      }),
      options(),
    ).evaluations[0];

    expect(result.coverage.availableTradeObservations).toBe(0);
    expect(result.coverage.availableForecastObservations).toBe(0);
    expect(result.exclusions.historicalEvidence.every(row =>
      row.reasons.includes("resolution-after-cutoff")
    )).toBe(true);
  });

  it("keeps trade TRUST and forecast Brier rankings separate", () => {
    const result = evaluateForecastersHistorically(
      input({
        tradeEvidence: [
          trade({ id: "a1", forecasterId: "trade-best", rMultiple: 1 }),
          trade({ id: "a2", forecasterId: "trade-best", rMultiple: 0 }),
          trade({ id: "b1", forecasterId: "forecast-best", rMultiple: 0.6 }),
          trade({ id: "b2", forecasterId: "forecast-best", rMultiple: -0.4 }),
        ],
        forecastEvidence: [
          forecast({ id: "af1", eventId: "ae1", forecasterId: "trade-best", probabilityYes: 0.2 }),
          forecast({ id: "af2", eventId: "ae2", forecasterId: "trade-best", probabilityYes: 0.2 }),
          forecast({ id: "bf1", eventId: "be1", forecasterId: "forecast-best", probabilityYes: 0.9 }),
          forecast({ id: "bf2", eventId: "be2", forecasterId: "forecast-best", probabilityYes: 0.9 }),
        ],
      }),
      options({
        selection: {
          trade: { minSampleSize: 2, topFraction: 0.5, ddof: 0 },
          forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
        },
      }),
    ).evaluations[0];

    expect(result.tradeRanking.map(row => row.forecasterId)).toEqual([
      "trade-best",
    ]);
    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual([
      "forecast-best",
    ]);
  });

  it("reports empty history and insufficient samples without treating them as zero", () => {
    const empty = evaluateForecastersHistorically(
      input({
        coverage: { tradeHistory: "unknown", forecastHistory: "partial" },
      }),
      options(),
    ).evaluations[0];
    const insufficient = evaluateForecastersHistorically(
      input({ tradeEvidence: [trade()], forecastEvidence: [forecast()] }),
      options(),
    ).evaluations[0];

    expect(empty.forecasters).toEqual([]);
    expect(empty.warnings).toEqual([
      "trade-history-completeness-not-verified",
      "forecast-history-completeness-not-verified",
      "no-trade-evidence-available",
      "no-forecast-evidence-available",
    ]);
    expect(insufficient.forecasters[0].trade.trust?.score).toBeNull();
    expect(insufficient.forecasters[0].forecast.metrics?.brierScore).not.toBeNull();
    expect(insufficient.warnings).toContain("insufficient-trade-sample");
    expect(insufficient.warnings).toContain("insufficient-forecast-sample");
  });

  it("does not call a sufficient zero-variance TRUST sample insufficient", () => {
    const result = evaluateForecastersHistorically(
      input({
        tradeEvidence: [
          trade({ id: "same-1", rMultiple: 1 }),
          trade({ id: "same-2", rMultiple: 1 }),
        ],
      }),
      options(),
    ).evaluations[0];

    expect(result.forecasters[0].trade.trust).toMatchObject({
      hasSufficientSample: true,
      reason: "zero-variance",
      score: null,
    });
    expect(result.forecasters[0].trade.reasons).toContain(
      "undefined-trust-score",
    );
    expect(result.warnings).not.toContain("insufficient-trade-sample");
  });

  it("preserves missing evidence categories instead of treating them as zero", () => {
    const result = evaluateForecastersHistorically(
      input({
        tradeEvidence: [trade({ forecasterId: "trade-only" })],
        forecastEvidence: [forecast({ forecasterId: "forecast-only" })],
      }),
      options(),
    ).evaluations[0];

    const tradeOnly = result.forecasters.find(row =>
      row.forecasterId === "trade-only"
    );
    const forecastOnly = result.forecasters.find(row =>
      row.forecasterId === "forecast-only"
    );
    expect(tradeOnly?.forecast.reasons).toEqual(["missing-evidence"]);
    expect(forecastOnly?.trade.reasons).toEqual(["missing-evidence"]);
  });

  it("rejects invalid, empty, and duplicate evaluation cutoffs", () => {
    expect(() => evaluateForecastersHistorically(input({ cutoffs: [] }), options()))
      .toThrow(RangeError);
    expect(() => evaluateForecastersHistorically(
      input({ cutoffs: [100, Number.NaN] }),
      options(),
    )).toThrow(TypeError);
    expect(() => evaluateForecastersHistorically(
      input({ cutoffs: [200, 100, 200] }),
      options(),
    )).toThrow(RangeError);
  });

  it("counts identical evidence IDs once and rejects conflicting IDs", () => {
    const exactTrade = trade({ id: "exact-trade" });
    const exactForecast = forecast({ id: "exact-forecast" });
    const result = evaluateForecastersHistorically(
      input({
        tradeEvidence: [
          exactTrade,
          { ...exactTrade },
          trade({ id: "trade-conflict", rMultiple: 1 }),
          trade({ id: "trade-conflict", rMultiple: -1 }),
        ],
        forecastEvidence: [
          exactForecast,
          { ...exactForecast },
          forecast({ id: "forecast-conflict", probabilityYes: 0.9 }),
          forecast({ id: "forecast-conflict", probabilityYes: 0.1 }),
        ],
      }),
      options({
        selection: {
          trade: { minSampleSize: 1, topFraction: 1, ddof: 0 },
          forecast: { minSampleSize: 1 },
        },
      }),
    ).evaluations[0];

    expect(result.coverage.availableTradeObservations).toBe(1);
    expect(result.coverage.availableForecastObservations).toBe(1);
    expect(result.forecasters[0].trade.trust?.sampleSize).toBe(1);
    expect(result.forecasters[0].forecast.metrics?.sampleSize).toBe(1);
    expect(result.exclusions.historicalEvidence.filter(row =>
      row.reasons.includes("duplicate-id")
    )).toHaveLength(2);
    expect(result.exclusions.historicalEvidence.filter(row =>
      row.reasons.includes("conflicting-duplicate-id")
    )).toHaveLength(4);
  });

  it("rejects single NaN evidence as invalid, not as duplicate conflict", () => {
    const result = evaluateForecastersHistorically(
      input({
        tradeEvidence: [trade({ id: "nan-trade", rMultiple: Number.NaN })],
        forecastEvidence: [
          forecast({ id: "nan-forecast", probabilityYes: Number.NaN }),
        ],
      }),
      options(),
    ).evaluations[0];

    expect(result.exclusions.historicalEvidence).toEqual([
      {
        category: "forecast",
        observationId: "nan-forecast",
        forecasterId: "alpha",
        reasons: ["invalid-probability"],
      },
      {
        category: "trade",
        observationId: "nan-trade",
        forecasterId: "alpha",
        reasons: ["invalid-r-multiple"],
      },
    ]);
    expect(result.exclusions.historicalEvidence.every(row =>
      !row.reasons.includes("conflicting-duplicate-id")
    )).toBe(true);
    expect(result.coverage.availableTradeObservations).toBe(0);
    expect(result.coverage.availableForecastObservations).toBe(0);
    expect(result.forecasters).toEqual([]);
  });

  it("prevents a later-available ID conflict from leaking into an earlier cutoff", () => {
    const result = evaluateForecastersHistorically(
      input({
        cutoffs: [150, 250],
        tradeEvidence: [
          trade({ id: "time-conflict", rMultiple: 1, availabilityTimestamp: 100 }),
          trade({ id: "time-conflict", rMultiple: -1, resolutionTimestamp: 180, availabilityTimestamp: 200 }),
        ],
      }),
      options({
        selection: {
          trade: { minSampleSize: 1, topFraction: 1, ddof: 0 },
          forecast: { minSampleSize: 1 },
        },
      }),
    );

    expect(result.evaluations[0].coverage.availableTradeObservations).toBe(1);
    expect(result.evaluations[0].forecasters[0].trade.trust?.sampleSize).toBe(1);
    expect(result.evaluations[1].coverage.availableTradeObservations).toBe(0);
    expect(result.evaluations[1].exclusions.historicalEvidence.filter(row =>
      row.reasons.includes("conflicting-duplicate-id")
    )).toHaveLength(2);
  });

  it("rejects evidence claimed available before its resolution", () => {
    const result = evaluateForecastersHistorically(
      input({
        tradeEvidence: [
          trade({ resolutionTimestamp: 120, availabilityTimestamp: 119 }),
        ],
        forecastEvidence: [
          forecast({ resolutionTimestamp: 120, availabilityTimestamp: 119 }),
        ],
      }),
      options(),
    ).evaluations[0];

    expect(result.coverage.availableTradeObservations).toBe(0);
    expect(result.coverage.availableForecastObservations).toBe(0);
    expect(result.exclusions.historicalEvidence.every(row =>
      row.reasons.includes("availability-before-resolution")
    )).toBe(true);
  });

  it("diagnoses malformed evidence and invalid historical timestamps", () => {
    const result = evaluateForecastersHistorically(
      input({
        tradeEvidence: [
          null,
          trade({ id: "unresolved", resolutionTimestamp: null as unknown as number }),
        ] as unknown as HistoricalTradeEvidence[],
        forecastEvidence: [
          forecast({ id: "bad-availability", availabilityTimestamp: Infinity }),
        ],
      }),
      options(),
    ).evaluations[0];

    expect(result.exclusions.historicalEvidence).toEqual([
      {
        category: "forecast",
        observationId: "bad-availability",
        forecasterId: "alpha",
        reasons: ["invalid-availability-timestamp"],
      },
      {
        category: "trade",
        observationId: null,
        forecasterId: null,
        reasons: ["malformed-observation"],
      },
      {
        category: "trade",
        observationId: "unresolved",
        forecasterId: "alpha",
        reasons: ["invalid-resolution-timestamp"],
      },
    ]);
  });

  it("is input-order invariant and never mutates caller input", () => {
    const original = input({
      cutoffs: [200, 120],
      tradeEvidence: [
        trade({ id: "t2", rMultiple: 0, availabilityTimestamp: 150 }),
        trade({ id: "t1" }),
      ],
      forecastEvidence: [
        forecast({ id: "f2", eventId: "e2", probabilityYes: 0.2, outcome: 0, availabilityTimestamp: 150 }),
        forecast({ id: "f1" }),
      ],
    });
    const snapshot = structuredClone(original);
    const forward = evaluateForecastersHistorically(original, options());
    const reverse = evaluateForecastersHistorically(
      {
        ...original,
        cutoffs: [...original.cutoffs].reverse(),
        tradeEvidence: [...original.tradeEvidence].reverse(),
        forecastEvidence: [...original.forecastEvidence].reverse(),
      },
      options(),
    );

    expect(reverse).toEqual(forward);
    expect(original).toEqual(snapshot);
  });

  it("reports coverage metadata without authenticating caller claims", () => {
    const result = evaluateForecastersHistorically(
      input({
        coverage: { tradeHistory: "partial", forecastHistory: "unknown" },
      }),
      options(),
    );

    expect(result.coverage).toEqual({
      basis: "caller-supplied-historical-evidence",
      provenance: "not-authenticated",
      tradeHistoryCompleteness: "partial",
      forecastHistoryCompleteness: "unknown",
    });
  });

  it("rejects malformed top-level input, options, and coverage metadata", () => {
    expect(() => evaluateForecastersHistorically(
      null as unknown as HistoricalEvaluationInput,
      options(),
    )).toThrow(TypeError);
    expect(() => evaluateForecastersHistorically(
      input({ tradeEvidence: null as unknown as HistoricalTradeEvidence[] }),
      options(),
    )).toThrow(TypeError);
    expect(() => evaluateForecastersHistorically(
      input({ coverage: { tradeHistory: "complete", forecastHistory: "bad" as "complete" } }),
      options(),
    )).toThrow(TypeError);
    expect(() => evaluateForecastersHistorically(
      input(),
      null as unknown as HistoricalEvaluationOptions,
    )).toThrow(TypeError);
  });
});
