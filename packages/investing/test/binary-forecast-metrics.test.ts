import { describe, expect, it } from "vitest";
import {
  computeBinaryForecastMetrics as computeWithCutoff,
  type BinaryForecastObservation,
  type BinaryForecastMetricsOptions,
} from "../src/prediction/analysis/binary-forecast-metrics";

// These are deliberately caller-supplied unit-test observations. They are not
// persisted forecasts and make no claim about real historical performance.
function observation(
  overrides: Partial<BinaryForecastObservation> = {},
): BinaryForecastObservation {
  return {
    id: "forecast-1",
    forecasterId: "caller-forecaster",
    eventId: "event-1",
    probabilityYes: 0.7,
    forecastTimestamp: 100,
    outcome: 1,
    resolutionTimestamp: 200,
    ...overrides,
  };
}

function computeBinaryForecastMetrics(
  observations: readonly BinaryForecastObservation[],
  options: Partial<BinaryForecastMetricsOptions> = {},
) {
  return computeWithCutoff(observations, { cutoff: 200, ...options });
}

describe("computeBinaryForecastMetrics", () => {
  it("computes a hand-calculated binary Brier Score", () => {
    const result = computeBinaryForecastMetrics([
      observation({ id: "a", eventId: "a", probabilityYes: 0.8, outcome: 1 }),
      observation({ id: "b", eventId: "b", probabilityYes: 0.3, outcome: 0 }),
      observation({ id: "c", eventId: "c", probabilityYes: 0.6, outcome: 1 }),
    ]);

    expect(result.coverage).toBe("caller-supplied-observations");
    expect(result.sampleSize).toBe(3);
    expect(result.brierScore).toBeCloseTo((0.04 + 0.09 + 0.16) / 3, 12);
    expect(result.forecasterId).toBe("caller-forecaster");
    expect(result.exclusions).toEqual([]);
  });

  it("gives perfect forecasts 0 and maximally wrong forecasts 1", () => {
    const perfect = computeBinaryForecastMetrics([
      observation({ id: "yes", eventId: "yes", probabilityYes: 1, outcome: 1 }),
      observation({ id: "no", eventId: "no", probabilityYes: 0, outcome: 0 }),
    ]);
    const wrong = computeBinaryForecastMetrics([
      observation({ id: "yes", eventId: "yes", probabilityYes: 0, outcome: 1 }),
      observation({ id: "no", eventId: "no", probabilityYes: 1, outcome: 0 }),
    ]);

    expect(perfect.brierScore).toBe(0);
    expect(wrong.brierScore).toBe(1);
  });

  it("accepts probability boundaries and puts 1.0 in the final bin", () => {
    const result = computeBinaryForecastMetrics([
      observation({ id: "zero", eventId: "zero", probabilityYes: 0, outcome: 0 }),
      observation({ id: "one", eventId: "one", probabilityYes: 1, outcome: 1 }),
    ]);

    expect(result.calibrationBins[0]).toMatchObject({
      lowerBound: 0,
      upperBound: 0.1,
      upperBoundInclusive: false,
      count: 1,
      meanProbability: 0,
      observedFrequency: 0,
    });
    expect(result.calibrationBins[9]).toMatchObject({
      lowerBound: 0.9,
      upperBound: 1,
      upperBoundInclusive: true,
      count: 1,
      meanProbability: 1,
      observedFrequency: 1,
    });
  });

  it("assigns forecasts to all ten equal-width bins deterministically", () => {
    const probabilities = [
      0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1,
    ];
    const result = computeBinaryForecastMetrics(
      probabilities.map((probabilityYes, index) =>
        observation({
          id: `bin-${index}`,
          eventId: `bin-${index}`,
          probabilityYes,
          outcome: index % 2 === 0 ? 0 : 1,
        }),
      ),
    );

    expect(result.calibrationBins.map(bin => bin.count)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 2,
    ]);
    result.calibrationBins.forEach((bin, index) => {
      expect(bin.index).toBe(index);
      expect(bin.lowerBound).toBe(index / 10);
      expect(bin.upperBound).toBe((index + 1) / 10);
      expect(bin.upperBoundInclusive).toBe(index === 9);
    });
    expect(result.calibrationBins[9].meanProbability).toBeCloseTo(0.95, 12);
  });

  it("excludes non-finite, out-of-range probabilities and non-numeric outcomes", () => {
    const inputs = [
      observation({ id: "nan", eventId: "nan", probabilityYes: Number.NaN }),
      observation({ id: "infinity", eventId: "infinity", probabilityYes: Infinity }),
      observation({ id: "low", eventId: "low", probabilityYes: -0.01 }),
      observation({ id: "high", eventId: "high", probabilityYes: 1.01 }),
      observation({ id: "boolean", eventId: "boolean", outcome: true as unknown as 0 }),
      observation({ id: "string", eventId: "string", outcome: "1" as unknown as 1 }),
      observation({ id: "negative", eventId: "negative", outcome: -1 as 0 }),
      observation({ id: "two", eventId: "two", outcome: 2 as 1 }),
      observation({ id: "nan-outcome", eventId: "nan-outcome", outcome: Number.NaN as 0 }),
    ];
    const result = computeBinaryForecastMetrics(inputs);

    expect(result.sampleSize).toBe(0);
    expect(result.brierScore).toBeNull();
    expect(result.exclusions.filter(x => x.reasons.includes("invalid-probability"))).toHaveLength(4);
    expect(result.exclusions.filter(x => x.reasons.includes("invalid-outcome"))).toHaveLength(5);
  });

  it("excludes invalid stable identities without trimming or coercion", () => {
    const result = computeBinaryForecastMetrics([
      observation({ id: "" }),
      observation({ id: " padded " }),
      observation({ id: "bad-forecaster", eventId: "bad-forecaster", forecasterId: "" }),
      observation({ id: "padded-forecaster", eventId: "padded-forecaster", forecasterId: " caller " }),
      observation({ id: "bad-event", eventId: "" }),
      observation({ id: "padded-event", eventId: " event " }),
    ]);

    expect(result.sampleSize).toBe(0);
    expect(result.exclusions.filter(x => x.reasons.includes("invalid-id"))).toHaveLength(2);
    expect(result.exclusions.filter(x => x.reasons.includes("invalid-forecaster-id"))).toHaveLength(2);
    expect(result.exclusions.filter(x => x.reasons.includes("invalid-event-id"))).toHaveLength(2);
  });

  it("requires a forecast strictly before resolution", () => {
    const result = computeBinaryForecastMetrics([
      observation({ id: "equal", eventId: "equal", forecastTimestamp: 200 }),
      observation({ id: "late", eventId: "late", forecastTimestamp: 201 }),
    ]);

    expect(result.sampleSize).toBe(0);
    expect(result.exclusions.every(x => x.reasons.includes("forecast-not-before-resolution"))).toBe(true);
  });

  it("uses an inclusive cutoff for both forecast and resolution timestamps", () => {
    const result = computeBinaryForecastMetrics(
      [
        observation({ id: "included", eventId: "included", forecastTimestamp: 199, resolutionTimestamp: 200 }),
        observation({ id: "future-resolution", eventId: "future-resolution", resolutionTimestamp: 201 }),
        observation({ id: "future-forecast", eventId: "future-forecast", forecastTimestamp: 201, resolutionTimestamp: 202 }),
      ],
      { cutoff: 200 },
    );

    expect(result.cutoff).toBe(200);
    expect(result.sampleSize).toBe(1);
    expect(result.exclusions.filter(x => x.reasons.includes("after-cutoff"))).toHaveLength(2);
  });

  it("prevents post-cutoff observations from altering an earlier score or bins", () => {
    const earlier = [
      observation({ id: "a", eventId: "a", probabilityYes: 0.8, outcome: 1 }),
      observation({ id: "b", eventId: "b", probabilityYes: 0.2, outcome: 0 }),
    ];
    const baseline = computeBinaryForecastMetrics(earlier, { cutoff: 200 });
    const withFuture = computeBinaryForecastMetrics(
      [
        ...earlier,
        observation({ id: "future", eventId: "future", probabilityYes: 1, outcome: 0, forecastTimestamp: 250, resolutionTimestamp: 300 }),
      ],
      { cutoff: 200 },
    );

    expect(withFuture.brierScore).toBe(baseline.brierScore);
    expect(withFuture.calibrationBins).toEqual(baseline.calibrationBins);
  });

  it("excludes unresolved and missing outcomes without inference", () => {
    const result = computeBinaryForecastMetrics([
      observation({ id: "missing", eventId: "missing", outcome: undefined as unknown as 0 }),
      observation({ id: "null", eventId: "null", outcome: null as unknown as 0 }),
      observation({ id: "missing-time", eventId: "missing-time", resolutionTimestamp: undefined as unknown as number }),
    ]);

    expect(result.sampleSize).toBe(0);
    expect(result.exclusions.map(x => x.reasons)).toEqual([
      ["invalid-outcome"],
      ["invalid-resolution-timestamp"],
      ["invalid-outcome"],
    ]);
  });

  it("counts identical non-empty IDs once and rejects conflicting IDs", () => {
    const exact = observation({ id: "exact", eventId: "exact" });
    const conflictA = observation({ id: "conflict", eventId: "conflict-a" });
    const conflictB = observation({ id: "conflict", eventId: "conflict-b" });
    const result = computeBinaryForecastMetrics([exact, { ...exact }, conflictA, conflictB]);

    expect(result.sampleSize).toBe(1);
    expect(result.exclusions.filter(x => x.reasons.includes("duplicate-id"))).toHaveLength(1);
    expect(result.exclusions.filter(x => x.reasons.includes("conflicting-duplicate-id"))).toHaveLength(2);
  });

  it("rejects an ID conflict before validity and cutoff filtering", () => {
    const valid = observation({ id: "conflict", eventId: "valid" });
    const invalid = observation({
      id: "conflict",
      eventId: "invalid",
      probabilityYes: 2,
      resolutionTimestamp: 300,
    });
    const result = computeBinaryForecastMetrics([valid, invalid]);

    expect(result.sampleSize).toBe(0);
    expect(result.exclusions).toEqual([
      {
        observationId: "conflict",
        forecasterId: "caller-forecaster",
        eventId: "invalid",
        reasons: ["conflicting-duplicate-id", "invalid-probability"],
      },
      {
        observationId: "conflict",
        forecasterId: "caller-forecaster",
        eventId: "valid",
        reasons: ["conflicting-duplicate-id"],
      },
    ]);
  });

  it("excludes every distinct observation for a duplicate forecaster/event", () => {
    const result = computeBinaryForecastMetrics([
      observation({ id: "first", forecastTimestamp: 100 }),
      observation({ id: "update", forecastTimestamp: 150 }),
    ]);

    expect(result.sampleSize).toBe(0);
    expect(result.exclusions).toHaveLength(2);
    expect(result.exclusions.every(x => x.reasons.includes("duplicate-event"))).toBe(true);
  });

  it("never silently combines mixed forecasters", () => {
    const mixed = [
      observation({ id: "a", eventId: "a", forecasterId: "a" }),
      observation({ id: "b", eventId: "b", forecasterId: "b" }),
    ];
    const implicit = computeBinaryForecastMetrics(mixed);
    const expected = computeBinaryForecastMetrics(mixed, { expectedForecasterId: "a" });

    expect(implicit.sampleSize).toBe(0);
    expect(implicit.forecasterId).toBeNull();
    expect(implicit.exclusions.every(x => x.reasons.includes("mixed-forecasters"))).toBe(true);
    expect(expected.sampleSize).toBe(1);
    expect(expected.forecasterId).toBe("a");
    expect(expected.exclusions).toEqual([
      {
        observationId: "b",
        forecasterId: "b",
        eventId: "b",
        reasons: ["forecaster-mismatch"],
      },
    ]);
  });

  it("returns null metrics and null rates for an empty valid sample", () => {
    const result = computeBinaryForecastMetrics([]);

    expect(result.brierScore).toBeNull();
    expect(result.sampleSize).toBe(0);
    expect(result.calibrationBins).toHaveLength(10);
    expect(result.calibrationBins.every(bin =>
      bin.count === 0 && bin.meanProbability === null && bin.observedFrequency === null
    )).toBe(true);
  });

  it("reports calibration counts, mean forecasts, and observed frequencies", () => {
    const result = computeBinaryForecastMetrics([
      observation({ id: "a", eventId: "a", probabilityYes: 0.21, outcome: 0 }),
      observation({ id: "b", eventId: "b", probabilityYes: 0.29, outcome: 1 }),
      observation({ id: "c", eventId: "c", probabilityYes: 0.75, outcome: 1 }),
    ]);

    expect(result.calibrationBins[2]).toMatchObject({
      count: 2,
      meanProbability: 0.25,
      observedFrequency: 0.5,
    });
    expect(result.calibrationBins[7]).toMatchObject({
      count: 1,
      meanProbability: 0.75,
      observedFrequency: 1,
    });
  });

  it("is input-order invariant and does not mutate caller observations", () => {
    const rows = [
      observation({ id: "z", eventId: "z", probabilityYes: 0.9 }),
      observation({ id: "a", eventId: "a", probabilityYes: 0.2, outcome: 0 }),
      observation({ id: "bad", eventId: "bad", probabilityYes: 2 }),
    ];
    const snapshot = rows.map(row => ({ ...row }));
    const forward = computeBinaryForecastMetrics(rows);
    const reverse = computeBinaryForecastMetrics([...rows].reverse());

    expect(reverse).toEqual(forward);
    expect(rows).toEqual(snapshot);
  });

  it("reports malformed rows and invalid timestamps without coercion", () => {
    const result = computeBinaryForecastMetrics([
      null,
      "forecast",
      observation({ id: "nan-time", eventId: "nan-time", forecastTimestamp: Number.NaN }),
      observation({ id: "infinite-time", eventId: "infinite-time", forecastTimestamp: Infinity }),
      observation({ id: "string-time", eventId: "string-time", resolutionTimestamp: "200" as unknown as number }),
      observation({ id: "infinite-resolution", eventId: "infinite-resolution", resolutionTimestamp: Infinity }),
      { ...observation({ id: "missing-id", eventId: "missing-id" }), id: "" },
    ] as unknown as BinaryForecastObservation[]);

    expect(result.sampleSize).toBe(0);
    expect(result.exclusions.filter(x => x.reasons.includes("malformed-observation"))).toHaveLength(2);
    expect(result.exclusions.some(x => x.reasons.includes("invalid-forecast-timestamp"))).toBe(true);
    expect(result.exclusions.some(x => x.reasons.includes("invalid-resolution-timestamp"))).toBe(true);
    expect(result.exclusions.some(x => x.reasons.includes("invalid-id"))).toBe(true);
  });

  it("rejects malformed top-level inputs and options", () => {
    expect(() => computeBinaryForecastMetrics(null as unknown as BinaryForecastObservation[])).toThrow(TypeError);
    expect(() => computeWithCutoff([], undefined as unknown as BinaryForecastMetricsOptions)).toThrow(TypeError);
    expect(() => computeWithCutoff([], {} as BinaryForecastMetricsOptions)).toThrow(TypeError);
    expect(() => computeBinaryForecastMetrics([], { cutoff: Number.NaN })).toThrow(TypeError);
    expect(() => computeBinaryForecastMetrics([], { cutoff: "200" as unknown as number })).toThrow(TypeError);
    expect(() => computeBinaryForecastMetrics([], { expectedForecasterId: "" })).toThrow(TypeError);
    expect(() => computeWithCutoff([], null as unknown as BinaryForecastMetricsOptions)).toThrow(TypeError);
  });
});
