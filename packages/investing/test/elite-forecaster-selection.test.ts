import { describe, expect, it } from "vitest";
import {
  DEFAULT_ELITE_BRIER_SCORE_THRESHOLD,
  DEFAULT_ELITE_TRADE_TOP_FRACTION,
  selectEliteForecasters,
  type EliteForecasterEvidence,
  type EliteForecasterSelectionOptions,
  type ResolvedTradeEvidence,
} from "../src/prediction/analysis/elite-forecaster-selection";
import type { BinaryForecastObservation } from "../src/prediction/analysis/binary-forecast-metrics";

function trades(
  forecasterId: string,
  values: readonly number[],
  startTimestamp = 100,
): ResolvedTradeEvidence[] {
  return values.map((rMultiple, index) => ({
    id: `${forecasterId}-trade-${index}`,
    rMultiple,
    resolutionTimestamp: startTimestamp + index,
  }));
}

function forecasts(
  forecasterId: string,
  probabilities: readonly number[],
  outcome: 0 | 1 = 1,
  resolutionTimestamp = 150,
): BinaryForecastObservation[] {
  return probabilities.map((probabilityYes, index) => ({
    id: `${forecasterId}-forecast-${index}`,
    forecasterId,
    eventId: `${forecasterId}-event-${index}`,
    probabilityYes,
    forecastTimestamp: 50 + index,
    outcome,
    resolutionTimestamp,
  }));
}

function options(
  overrides: Partial<EliteForecasterSelectionOptions> = {},
): EliteForecasterSelectionOptions {
  return {
    cutoff: 200,
    trade: { minSampleSize: 2, topFraction: 1, ddof: 0 },
    forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
    ...overrides,
  };
}

describe("selectEliteForecasters", () => {
  it("returns independent trade TRUST and forecast Brier rankings", () => {
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "trade-elite",
          tradeObservations: trades("trade-elite", [1, 0, 1, 0]),
          forecastObservations: forecasts("trade-elite", [0.2, 0.2]),
        },
        {
          forecasterId: "forecast-elite",
          tradeObservations: trades("forecast-elite", [0.6, -0.4, 0.6, -0.4]),
          forecastObservations: forecasts("forecast-elite", [0.9, 0.9]),
        },
      ],
      options({
        trade: { minSampleSize: 2, topFraction: 0.5, ddof: 0 },
        forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
      }),
    );

    expect(result.tradeRanking.map(row => row.forecasterId)).toEqual([
      "trade-elite",
    ]);
    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual([
      "forecast-elite",
    ]);
    expect(result.assessments.find(x => x.forecasterId === "forecast-elite")?.trade.reasons)
      .toContain("outside-top-fraction");
    expect(result.assessments.find(x => x.forecasterId === "trade-elite")?.forecast.reasons)
      .toContain("brier-score-not-below-threshold");
  });

  it("enforces sample minimums inclusively at their boundary", () => {
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "at-boundary",
          tradeObservations: trades("at-boundary", [1, 0]),
          forecastObservations: forecasts("at-boundary", [0.9, 0.9]),
        },
        {
          forecasterId: "below-boundary",
          tradeObservations: trades("below-boundary", [1]),
          forecastObservations: forecasts("below-boundary", [0.9]),
        },
      ],
      options(),
    );

    expect(result.tradeRanking.map(row => row.forecasterId)).toEqual([
      "at-boundary",
    ]);
    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual([
      "at-boundary",
    ]);
    const below = result.assessments.find(x => x.forecasterId === "below-boundary");
    expect(below?.trade.reasons).toContain("insufficient-sample");
    expect(below?.forecast.reasons).toContain("insufficient-sample");
  });

  it("uses a strict Brier threshold and an optional TRUST floor", () => {
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "exact-brier",
          tradeObservations: trades("exact-brier", [0.6, -0.4]),
          forecastObservations: forecasts("exact-brier", [0.5, 0.5]),
        },
        {
          forecasterId: "below-brier",
          tradeObservations: trades("below-brier", [1, 0]),
          forecastObservations: forecasts("below-brier", [0.6, 0.6]),
        },
      ],
      options({
        trade: {
          minSampleSize: 2,
          topFraction: 1,
          minimumTrustScore: 1,
          ddof: 0,
        },
        forecast: { minSampleSize: 2, brierScoreThreshold: 0.25 },
      }),
    );

    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual([
      "below-brier",
    ]);
    expect(result.assessments.find(x => x.forecasterId === "exact-brier")?.forecast.reasons)
      .toContain("brier-score-not-below-threshold");
    expect(result.assessments.find(x => x.forecasterId === "exact-brier")?.trade.reasons)
      .toContain("below-minimum-trust-score");
  });

  it("does not promote missing, empty, or undefined evidence", () => {
    const result = selectEliteForecasters(
      [
        { forecasterId: "missing" },
        {
          forecasterId: "empty",
          tradeObservations: [],
          forecastObservations: [],
        },
        {
          forecasterId: "undefined-trust",
          tradeObservations: trades("undefined-trust", [0, 0]),
          forecastObservations: forecasts("undefined-trust", [0.9]),
        },
      ],
      options(),
    );

    expect(result.tradeRanking).toEqual([]);
    expect(result.forecastRanking).toEqual([]);
    expect(result.assessments.find(x => x.forecasterId === "missing")?.trade.reasons)
      .toEqual(["missing-evidence"]);
    expect(result.assessments.find(x => x.forecasterId === "empty")?.trade.reasons)
      .toEqual(["insufficient-sample", "undefined-trust-score"]);
    expect(result.assessments.find(x => x.forecasterId === "undefined-trust")?.trade.reasons)
      .toContain("undefined-trust-score");
  });

  it("excludes trade and forecast evidence after the inclusive cutoff", () => {
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "timed",
          tradeObservations: [
            ...trades("timed", [1], 200),
            ...trades("future", [0], 201),
          ],
          forecastObservations: [
            ...forecasts("timed", [0.9], 1, 200),
            ...forecasts("future", [0.9], 1, 201).map(row => ({
              ...row,
              forecasterId: "timed",
            })),
          ],
        },
      ],
      options(),
    );

    const assessment = result.assessments[0];
    expect(assessment.trade.trust?.sampleSize).toBe(1);
    expect(assessment.trade.exclusions[0].reasons).toContain("after-cutoff");
    expect(assessment.forecast.metrics?.sampleSize).toBe(1);
    expect(assessment.forecast.metrics?.exclusions[0].reasons).toContain("after-cutoff");
    expect(result.tradeRanking).toEqual([]);
    expect(result.forecastRanking).toEqual([]);
  });

  it("orders tied scores by ID and is stable across input permutations", () => {
    const rows: EliteForecasterEvidence[] = ["zeta", "alpha"].map(forecasterId => ({
      forecasterId,
      tradeObservations: trades(forecasterId, [1, 0]),
      forecastObservations: forecasts(forecasterId, [0.9, 0.9]),
    }));
    const snapshot = structuredClone(rows);
    const forward = selectEliteForecasters(rows, options());
    const reverse = selectEliteForecasters([...rows].reverse(), options());

    expect(forward.tradeRanking.map(row => row.forecasterId)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(forward.forecastRanking.map(row => row.forecasterId)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(reverse).toEqual(forward);
    expect(rows).toEqual(snapshot);
  });

  it("counts identical forecaster entries once and rejects conflicting ones", () => {
    const exact: EliteForecasterEvidence = {
      forecasterId: "exact",
      tradeObservations: trades("exact", [1, 0]),
      forecastObservations: forecasts("exact", [0.9, 0.9]),
    };
    const result = selectEliteForecasters(
      [
        exact,
        structuredClone(exact),
        { forecasterId: "conflict", tradeObservations: trades("conflict-a", [1, 0]) },
        { forecasterId: "conflict", tradeObservations: trades("conflict-b", [0.5, -0.5]) },
      ],
      options(),
    );

    expect(result.tradeRanking.map(row => row.forecasterId)).toEqual(["exact"]);
    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual(["exact"]);
    expect(result.assessments.map(row => row.forecasterId)).toEqual(["exact"]);
    expect(result.inputExclusions.filter(x => x.reasons.includes("duplicate-forecaster")))
      .toHaveLength(1);
    expect(result.inputExclusions.filter(x => x.reasons.includes("conflicting-duplicate-forecaster")))
      .toHaveLength(2);
  });

  it("does not misclassify repeated invalid NaN evidence as a forecaster conflict", () => {
    const invalid: EliteForecasterEvidence = {
      forecasterId: "nan-evidence",
      tradeObservations: [
        {
          id: "nan-trade",
          rMultiple: Number.NaN,
          resolutionTimestamp: 100,
        },
      ],
      forecastObservations: [
        {
          id: "nan-forecast",
          forecasterId: "nan-evidence",
          eventId: "nan-event",
          probabilityYes: Number.NaN,
          forecastTimestamp: 50,
          outcome: 1,
          resolutionTimestamp: 100,
        },
      ],
    };
    const result = selectEliteForecasters(
      [invalid, structuredClone(invalid)],
      options(),
    );

    expect(result.inputExclusions).toEqual([
      { forecasterId: "nan-evidence", reasons: ["duplicate-forecaster"] },
    ]);
    expect(result.assessments).toHaveLength(1);
    expect(result.assessments[0].trade.exclusions).toEqual([
      { observationId: "nan-trade", reasons: ["invalid-r-multiple"] },
    ]);
    expect(result.assessments[0].forecast.metrics?.exclusions).toEqual([
      expect.objectContaining({ reasons: ["invalid-probability"] }),
    ]);
  });

  it("treats identical trade evidence in different orders as one forecaster", () => {
    const ordered = trades("trade-order", [1, 0, 0.5]);
    const result = selectEliteForecasters(
      [
        { forecasterId: "trade-order", tradeObservations: ordered },
        {
          forecasterId: "trade-order",
          tradeObservations: [ordered[2], ordered[0], ordered[1]],
        },
      ],
      options({
        trade: { minSampleSize: 2, topFraction: 1, ddof: 0 },
        forecast: { minSampleSize: 1 },
      }),
    );

    expect(result.assessments.map(row => row.forecasterId)).toEqual([
      "trade-order",
    ]);
    expect(result.inputExclusions).toEqual([
      { forecasterId: "trade-order", reasons: ["duplicate-forecaster"] },
    ]);
  });

  it("treats identical forecast evidence in different orders as one forecaster", () => {
    const ordered = forecasts("forecast-order", [0.9, 0.8, 0.7]);
    const result = selectEliteForecasters(
      [
        { forecasterId: "forecast-order", forecastObservations: ordered },
        {
          forecasterId: "forecast-order",
          forecastObservations: [ordered[1], ordered[2], ordered[0]],
        },
      ],
      options({
        trade: { minSampleSize: 1, topFraction: 1 },
        forecast: { minSampleSize: 2 },
      }),
    );

    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual([
      "forecast-order",
    ]);
    expect(result.inputExclusions).toEqual([
      { forecasterId: "forecast-order", reasons: ["duplicate-forecaster"] },
    ]);
  });

  it("treats identical combined evidence in different orders as one forecaster", () => {
    const tradeRows = trades("combined-order", [1, 0, 0.5]);
    const forecastRows = forecasts("combined-order", [0.9, 0.8, 0.7]);
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "combined-order",
          tradeObservations: tradeRows,
          forecastObservations: forecastRows,
        },
        {
          forecasterId: "combined-order",
          tradeObservations: [...tradeRows].reverse(),
          forecastObservations: [
            forecastRows[2],
            forecastRows[0],
            forecastRows[1],
          ],
        },
      ],
      options(),
    );

    expect(result.tradeRanking.map(row => row.forecasterId)).toEqual([
      "combined-order",
    ]);
    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual([
      "combined-order",
    ]);
    expect(result.inputExclusions).toEqual([
      { forecasterId: "combined-order", reasons: ["duplicate-forecaster"] },
    ]);
  });

  it("rejects duplicate forecasters with materially conflicting observations", () => {
    const tradeRows = trades("material-conflict", [1, 0]);
    const forecastRows = forecasts("material-conflict", [0.9, 0.8]);
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "material-conflict",
          tradeObservations: tradeRows,
          forecastObservations: forecastRows,
        },
        {
          forecasterId: "material-conflict",
          tradeObservations: [
            tradeRows[0],
            { ...tradeRows[1], rMultiple: 0.25 },
          ],
          forecastObservations: forecastRows,
        },
      ],
      options(),
    );

    expect(result.assessments).toEqual([]);
    expect(result.inputExclusions).toEqual([
      {
        forecasterId: "material-conflict",
        reasons: ["conflicting-duplicate-forecaster"],
      },
      {
        forecasterId: "material-conflict",
        reasons: ["conflicting-duplicate-forecaster"],
      },
    ]);
  });

  it("is deterministic across outer and nested evidence permutations", () => {
    const alphaTrades = trades("alpha-nested", [1, 0, 0.5]);
    const alphaForecasts = forecasts("alpha-nested", [0.9, 0.8, 0.7]);
    const alpha: EliteForecasterEvidence = {
      forecasterId: "alpha-nested",
      tradeObservations: alphaTrades,
      forecastObservations: alphaForecasts,
    };
    const alphaReordered: EliteForecasterEvidence = {
      forecasterId: "alpha-nested",
      tradeObservations: [...alphaTrades].reverse(),
      forecastObservations: [...alphaForecasts].reverse(),
    };
    const beta: EliteForecasterEvidence = {
      forecasterId: "beta-nested",
      tradeObservations: trades("beta-nested", [0.75, -0.25, 0.25]),
      forecastObservations: forecasts("beta-nested", [0.85, 0.75, 0.65]),
    };

    const forward = selectEliteForecasters(
      [alpha, alphaReordered, beta],
      options(),
    );
    const permuted = selectEliteForecasters(
      [beta, alphaReordered, alpha],
      options(),
    );

    expect(permuted).toEqual(forward);
  });

  it.each([
    [1, 1],
    [9, 1],
    [10, 1],
    [11, 2],
    [20, 2],
    [21, 3],
  ])(
    "uses ceiling rounding for the default top 10%% cohort: %i candidates select %i",
    (candidateCount, expectedSelected) => {
      const cohort: EliteForecasterEvidence[] = Array.from(
        { length: candidateCount },
        (_, index) => {
          const forecasterId = `cohort-${index.toString().padStart(2, "0")}`;
          return {
            forecasterId,
            tradeObservations: trades(
              forecasterId,
              Array.from({ length: 26 }, (_, tradeIndex) =>
                tradeIndex % 2 === 0 ? 1 : 0,
              ),
            ),
          };
        },
      );
      const result = selectEliteForecasters(cohort, {
        cutoff: 200,
        trade: {},
        forecast: { minSampleSize: 1 },
      });

      expect(result.thresholds.tradeTopFraction).toBe(0.1);
      expect(result.tradeRanking).toHaveLength(expectedSelected);
    },
  );

  it("enforces the default strict Brier Score threshold of 0.15", () => {
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "below-default",
          forecastObservations: forecasts("below-default", [0, 0.3, 0.59], 0),
        },
        {
          forecasterId: "exact-default",
          forecastObservations: forecasts("exact-default", [0, 0.3, 0.6], 0),
        },
        {
          forecasterId: "above-default",
          forecastObservations: forecasts("above-default", [0, 0.3, 0.61], 0),
        },
      ],
      {
        cutoff: 200,
        trade: {},
        forecast: { minSampleSize: 3 },
      },
    );

    expect(result.forecastRanking.map(row => row.forecasterId)).toEqual([
      "below-default",
    ]);
    expect(result.assessments.find(x => x.forecasterId === "exact-default")?.forecast.metrics?.brierScore)
      .toBe(0.15);
    expect(result.assessments.find(x => x.forecasterId === "exact-default")?.forecast.reasons)
      .toContain("brier-score-not-below-threshold");
    expect(result.assessments.find(x => x.forecasterId === "above-default")?.forecast.reasons)
      .toContain("brier-score-not-below-threshold");
  });

  it("returns deterministic empty structures for empty and all-ineligible input", () => {
    const empty = selectEliteForecasters([], options());
    const allIneligible = selectEliteForecasters(
      [{ forecasterId: "none", tradeObservations: [], forecastObservations: [] }],
      options(),
    );

    expect(empty.tradeRanking).toEqual([]);
    expect(empty.forecastRanking).toEqual([]);
    expect(empty.assessments).toEqual([]);
    expect(allIneligible.tradeRanking).toEqual([]);
    expect(allIneligible.forecastRanking).toEqual([]);
  });

  it("reports malformed forecasters and invalid evidence without coercion", () => {
    const result = selectEliteForecasters(
      [
        null,
        { forecasterId: "" },
        {
          forecasterId: "invalid",
          tradeObservations: [
            null,
            { id: "", rMultiple: 1, resolutionTimestamp: 100 },
            { id: "nan", rMultiple: Number.NaN, resolutionTimestamp: 100 },
            { id: "time", rMultiple: 1, resolutionTimestamp: Infinity },
          ],
          forecastObservations: "not-an-array",
        },
      ] as unknown as EliteForecasterEvidence[],
      options(),
    );

    expect(result.inputExclusions).toEqual([
      { forecasterId: null, reasons: ["invalid-forecaster-id"] },
      { forecasterId: null, reasons: ["malformed-evidence"] },
    ]);
    const invalid = result.assessments[0];
    expect(invalid.trade.trust?.sampleSize).toBe(0);
    expect(invalid.trade.exclusions).toHaveLength(4);
    expect(invalid.forecast.reasons).toEqual(["invalid-evidence"]);
  });

  it("deduplicates trade IDs conservatively before scoring", () => {
    const duplicate = trades("dup", [1, 0]);
    const conflictA = { id: "conflict", rMultiple: 1, resolutionTimestamp: 100 };
    const conflictB = { id: "conflict", rMultiple: 0, resolutionTimestamp: 100 };
    const result = selectEliteForecasters(
      [
        {
          forecasterId: "dup",
          tradeObservations: [
            duplicate[0],
            { ...duplicate[0] },
            duplicate[1],
            conflictA,
            conflictB,
          ],
          forecastObservations: forecasts("dup", [0.9, 0.9]),
        },
      ],
      options(),
    );

    expect(result.assessments[0].trade.trust?.sampleSize).toBe(2);
    expect(result.assessments[0].trade.exclusions.filter(x => x.reasons.includes("duplicate-id")))
      .toHaveLength(1);
    expect(result.assessments[0].trade.exclusions.filter(x => x.reasons.includes("conflicting-duplicate-id")))
      .toHaveLength(2);
  });

  it("uses documented roadmap defaults while requiring a forecast sample minimum", () => {
    const result = selectEliteForecasters([], {
      cutoff: 200,
      trade: {},
      forecast: { minSampleSize: 5 },
    });

    expect(result.thresholds).toMatchObject({
      tradeMinSampleSize: 25,
      tradeTopFraction: DEFAULT_ELITE_TRADE_TOP_FRACTION,
      forecastMinSampleSize: 5,
      brierScoreThreshold: DEFAULT_ELITE_BRIER_SCORE_THRESHOLD,
    });
  });

  it("rejects malformed top-level inputs and invalid thresholds", () => {
    expect(() => selectEliteForecasters(null as unknown as EliteForecasterEvidence[], options()))
      .toThrow(TypeError);
    expect(() => selectEliteForecasters([], null as unknown as EliteForecasterSelectionOptions))
      .toThrow(TypeError);
    expect(() => selectEliteForecasters([], options({ cutoff: Number.NaN })))
      .toThrow(TypeError);
    expect(() => selectEliteForecasters([], options({ trade: { minSampleSize: 0 } })))
      .toThrow(RangeError);
    expect(() => selectEliteForecasters([], options({ trade: { topFraction: 0 } })))
      .toThrow(RangeError);
    expect(() => selectEliteForecasters([], options({ forecast: { minSampleSize: 0 } })))
      .toThrow(RangeError);
    expect(() => selectEliteForecasters([], options({
      forecast: { minSampleSize: 2, brierScoreThreshold: 2 },
    }))).toThrow(RangeError);
  });
});
