import { describe, expect, it } from "vitest";
import {
  evaluateForecasterBaselines,
  type ForecasterBaselineInput,
  type ForecasterBaselineOptions,
} from "../src/prediction/analysis/forecaster-baselines";
import type {
  HistoricalForecastEvidence,
  HistoricalTradeEvidence,
} from "../src/prediction/analysis/historical-forecaster-evaluation";

// These synthetic fixtures test mechanics only. They do not establish that any
// strategy has real-world predictive value.
function trade(
  forecasterId: string,
  index: number,
  rMultiple: number,
  overrides: Partial<HistoricalTradeEvidence> = {},
): HistoricalTradeEvidence {
  return {
    id: `${forecasterId}-trade-${index}`,
    forecasterId,
    rMultiple,
    resolutionTimestamp: 70 + index,
    availabilityTimestamp: 80 + index,
    ...overrides,
  };
}

function forecast(
  forecasterId: string,
  index: number,
  probabilityYes: number,
  overrides: Partial<HistoricalForecastEvidence> = {},
): HistoricalForecastEvidence {
  return {
    id: `${forecasterId}-forecast-${index}`,
    forecasterId,
    eventId: `${forecasterId}-event-${index}`,
    probabilityYes,
    forecastTimestamp: 20 + index,
    outcome: 1,
    resolutionTimestamp: 70 + index,
    availabilityTimestamp: 80 + index,
    ...overrides,
  };
}

function evidenceFor(
  ids: readonly string[],
): Pick<ForecasterBaselineInput, "tradeEvidence" | "forecastEvidence"> {
  return {
    tradeEvidence: ids.flatMap((id, position) => [
      trade(id, 0, 0.2 + position / 10),
      trade(id, 1, 1.2 + position / 10),
    ]),
    forecastEvidence: ids.flatMap((id, position) => [
      forecast(id, 0, 0.95 - position / 20),
      forecast(id, 1, 0.85 - position / 20),
    ]),
  };
}

function input(
  overrides: Partial<ForecasterBaselineInput> = {},
): ForecasterBaselineInput {
  return {
    windows: [{ id: "window-1", selectionCutoff: 100, evaluationCutoff: 200 }],
    tradeEvidence: [],
    forecastEvidence: [],
    coverage: { tradeHistory: "complete", forecastHistory: "complete" },
    ...overrides,
  };
}

function options(
  overrides: Partial<ForecasterBaselineOptions> = {},
): ForecasterBaselineOptions {
  return {
    randomSeed: 12345,
    selection: {
      trade: { minSampleSize: 2, topFraction: 0.5, ddof: 0 },
      forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
    },
    ...overrides,
  };
}

function evaluateAlphaWithSubsequent(
  laterTrades: readonly HistoricalTradeEvidence[],
  laterForecasts: readonly HistoricalForecastEvidence[],
) {
  const initial = evidenceFor(["alpha"]);
  return evaluateForecasterBaselines(
    input({
      tradeEvidence: [...initial.tradeEvidence, ...laterTrades],
      forecastEvidence: [...initial.forecastEvidence, ...laterForecasts],
    }),
    options({
      selection: {
        trade: { minSampleSize: 2, topFraction: 1, ddof: 0 },
        forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
      },
    }),
  ).windows[0];
}

describe("evaluateForecasterBaselines", () => {
  it("builds independent TRUST, Brier, random, and Day 7 elite strategies", () => {
    const supplied = evidenceFor(["alpha", "bravo", "charlie", "delta"]);
    const result = evaluateForecasterBaselines(input(supplied), options());
    const baselines = result.windows[0].baselines;

    expect(baselines.trust.ranking.map(row => row.forecasterId)).toEqual([
      "delta",
      "charlie",
      "bravo",
      "alpha",
    ]);
    expect(baselines.brier.ranking.map(row => row.forecasterId)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    expect(baselines.eliteTrade.map(row => row.forecasterId)).toEqual([
      "delta",
      "charlie",
    ]);
    expect(baselines.eliteForecast.map(row => row.forecasterId)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    expect(baselines.randomTrade.candidatePool).toEqual(
      baselines.trust.candidatePool,
    );
    expect(baselines.randomForecast.candidatePool).toEqual(
      baselines.brier.candidatePool,
    );
    expect(baselines.randomTrade.selectionSize).toBe(
      baselines.eliteTrade.length,
    );
    expect(baselines.randomForecast.selectionSize).toBe(
      baselines.eliteForecast.length,
    );
    expect(result.limitations).toContain(
      "TRUST and Brier use different evidence categories and are not directly comparable.",
    );
  });

  it("uses reproducible seeded random controls independent of input order", () => {
    const supplied = evidenceFor(["a", "b", "c", "d", "e", "f"]);
    const forward = evaluateForecasterBaselines(input(supplied), options());
    const reversed = evaluateForecasterBaselines(
      input({
        tradeEvidence: [...supplied.tradeEvidence].reverse(),
        forecastEvidence: [...supplied.forecastEvidence].reverse(),
      }),
      options(),
    );
    const otherSeed = evaluateForecasterBaselines(
      input(supplied),
      options({ randomSeed: 54321 }),
    );

    expect(reversed).toEqual(forward);
    expect(forward.windows[0].baselines.randomTrade.selectedForecasterIds)
      .not.toEqual(otherSeed.windows[0].baselines.randomTrade.selectedForecasterIds);
  });

  it("keeps selection evidence out of subsequent outcome metrics", () => {
    const supplied = evidenceFor(["alpha", "bravo"]);
    const laterTrades = [
      trade("alpha", 2, -1, { resolutionTimestamp: 140, availabilityTimestamp: 150 }),
      trade("alpha", 3, 1, { resolutionTimestamp: 150, availabilityTimestamp: 160 }),
    ];
    const laterForecasts = [
      forecast("alpha", 2, 0.1, {
        outcome: 0,
        forecastTimestamp: 110,
        resolutionTimestamp: 140,
        availabilityTimestamp: 150,
      }),
      forecast("alpha", 3, 0.9, {
        forecastTimestamp: 120,
        resolutionTimestamp: 150,
        availabilityTimestamp: 160,
      }),
    ];
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [...supplied.tradeEvidence, ...laterTrades],
        forecastEvidence: [...supplied.forecastEvidence, ...laterForecasts],
      }),
      options({
        selection: {
          trade: { minSampleSize: 2, topFraction: 1, ddof: 0 },
          forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
        },
      }),
    );
    const window = result.windows[0];
    const trustOutcome = window.subsequentOutcomes.trust.entries.find(
      row => row.forecasterId === "alpha",
    );
    const brierOutcome = window.subsequentOutcomes.brier.entries.find(
      row => row.forecasterId === "alpha",
    );

    expect(trustOutcome?.trust?.sampleSize).toBe(2);
    expect(brierOutcome?.forecastMetrics?.sampleSize).toBe(2);
    expect(brierOutcome?.forecastMetrics?.brierScore).toBeCloseTo(0.01);
  });

  it("marks one subsequent forecast insufficient when the minimum is two", () => {
    const window = evaluateAlphaWithSubsequent([], [
      forecast("alpha", 2, 0.9, {
        forecastTimestamp: 110,
        resolutionTimestamp: 140,
        availabilityTimestamp: 150,
      }),
    ]);
    const outcome = window.subsequentOutcomes.brier.entries[0];

    expect(outcome).toMatchObject({
      status: "insufficient-subsequent-evidence",
      hasSufficientSample: false,
    });
    expect(outcome.forecastMetrics?.sampleSize).toBe(1);
    expect(window.evaluationWarnings.subsequent).toContain(
      "insufficient-forecast-sample",
    );
  });

  it("marks one subsequent trade insufficient when the minimum is two", () => {
    const window = evaluateAlphaWithSubsequent([
      trade("alpha", 2, 1, {
        resolutionTimestamp: 140,
        availabilityTimestamp: 150,
      }),
    ], []);
    const outcome = window.subsequentOutcomes.trust.entries[0];

    expect(outcome).toMatchObject({
      status: "insufficient-subsequent-evidence",
      hasSufficientSample: false,
    });
    expect(outcome.trust?.sampleSize).toBe(1);
    expect(window.evaluationWarnings.subsequent).toContain(
      "insufficient-trade-sample",
    );
  });

  it("keeps sufficient trade and insufficient forecast outcomes independent", () => {
    const window = evaluateAlphaWithSubsequent(
      [
        trade("alpha", 2, -1, {
          resolutionTimestamp: 140,
          availabilityTimestamp: 150,
        }),
        trade("alpha", 3, 1, {
          resolutionTimestamp: 150,
          availabilityTimestamp: 160,
        }),
      ],
      [
        forecast("alpha", 2, 0.9, {
          forecastTimestamp: 110,
          resolutionTimestamp: 140,
          availabilityTimestamp: 150,
        }),
      ],
    );

    expect(window.subsequentOutcomes.trust.entries[0]).toMatchObject({
      status: "evaluated",
      hasSufficientSample: true,
    });
    expect(window.subsequentOutcomes.brier.entries[0]).toMatchObject({
      status: "insufficient-subsequent-evidence",
      hasSufficientSample: false,
    });
  });

  it("keeps sufficient forecast and insufficient trade outcomes independent", () => {
    const window = evaluateAlphaWithSubsequent(
      [
        trade("alpha", 2, 1, {
          resolutionTimestamp: 140,
          availabilityTimestamp: 150,
        }),
      ],
      [
        forecast("alpha", 2, 0.1, {
          outcome: 0,
          forecastTimestamp: 110,
          resolutionTimestamp: 140,
          availabilityTimestamp: 150,
        }),
        forecast("alpha", 3, 0.9, {
          forecastTimestamp: 120,
          resolutionTimestamp: 150,
          availabilityTimestamp: 160,
        }),
      ],
    );

    expect(window.subsequentOutcomes.trust.entries[0]).toMatchObject({
      status: "insufficient-subsequent-evidence",
      hasSufficientSample: false,
    });
    expect(window.subsequentOutcomes.brier.entries[0]).toMatchObject({
      status: "evaluated",
      hasSufficientSample: true,
    });
  });

  it("distinguishes missing subsequent evidence from insufficient evidence", () => {
    const window = evaluateAlphaWithSubsequent([], []);

    expect(window.subsequentOutcomes.trust.entries[0]).toMatchObject({
      status: "missing-subsequent-evidence",
      hasSufficientSample: false,
      trust: null,
    });
    expect(window.subsequentOutcomes.brier.entries[0]).toMatchObject({
      status: "missing-subsequent-evidence",
      hasSufficientSample: false,
      forecastMetrics: null,
    });
    expect(window.evaluationWarnings.subsequent).toEqual(
      expect.arrayContaining([
        "no-trade-evidence-available",
        "no-forecast-evidence-available",
      ]),
    );
  });

  it("reports empty and insufficient pools without treating missing scores as zero", () => {
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [trade("alpha", 0, 1)],
        forecastEvidence: [forecast("alpha", 0, 0.9)],
      }),
      options(),
    );
    const window = result.windows[0];

    expect(window.baselines.trust.ranking).toEqual([]);
    expect(window.baselines.brier.ranking).toEqual([]);
    expect(window.baselines.randomTrade.selectedForecasterIds).toEqual([]);
    expect(window.baselines.randomForecast.selectedForecasterIds).toEqual([]);
    expect(window.warnings).toContain("insufficient-trade-sample");
    expect(window.warnings).toContain("insufficient-forecast-sample");
    expect(window.warnings).toContain("no eligible TRUST baseline candidates");
    expect(window.warnings).toContain("no eligible Brier baseline candidates");

    const empty = evaluateForecasterBaselines(input(), options());
    expect(empty.windows[0].selectionMetrics).toEqual([]);
    expect(empty.windows[0].baselines.trust.selectedForecasterIds).toEqual([]);
    expect(empty.windows[0].baselines.brier.selectedForecasterIds).toEqual([]);
    expect(empty.stability.inclusionFrequency).toEqual([]);
  });

  it("detects and prevents future evidence from affecting historical selection", () => {
    const supplied = evidenceFor(["alpha"]);
    const futureTrade = trade("future", 0, 100, {
      resolutionTimestamp: 120,
      availabilityTimestamp: 130,
    });
    const futureForecast = forecast("future", 0, 1, {
      forecastTimestamp: 110,
      resolutionTimestamp: 120,
      availabilityTimestamp: 130,
    });
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [...supplied.tradeEvidence, futureTrade],
        forecastEvidence: [...supplied.forecastEvidence, futureForecast],
      }),
      options(),
    );
    const reasons = result.windows[0].leakageFindings.map(row => row.reason);

    expect(result.windows[0].selectionMetrics.map(row => row.forecasterId))
      .not.toContain("future");
    expect(reasons).toContain("trade-resolved-after-selection-cutoff");
    expect(reasons).toContain("forecast-resolved-after-selection-cutoff");
    expect(reasons).toContain("availability-after-selection-cutoff");
    expect(reasons).not.toContain("future-observation-influenced-ranking");
  });

  it("reports exact and conflicting duplicates while counting exact rows once", () => {
    const baseTrade = trade("alpha", 0, 0);
    const secondTrade = trade("alpha", 1, 1);
    const baseForecast = forecast("alpha", 0, 0.9);
    const secondForecast = forecast("alpha", 1, 0.8);
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [
          baseTrade,
          { ...baseTrade },
          secondTrade,
          trade("conflict", 0, 0),
          trade("conflict", 0, 1),
        ],
        forecastEvidence: [baseForecast, { ...baseForecast }, secondForecast],
      }),
      options(),
    );
    const alpha = result.windows[0].selectionMetrics.find(
      row => row.forecasterId === "alpha",
    );
    const findings = result.windows[0].leakageFindings;

    expect(alpha?.trade.trust?.sampleSize).toBe(2);
    expect(alpha?.forecast.metrics?.sampleSize).toBe(2);
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "duplicate-observation-id", affectedIds: ["alpha-trade-0"] }),
      expect.objectContaining({ reason: "duplicate-observation-id", affectedIds: ["alpha-forecast-0"] }),
      expect.objectContaining({ reason: "conflicting-duplicate-observation-id", affectedIds: ["conflict-trade-0"] }),
    ]));
  });

  it("uses Day 8 numeric duplicate semantics for 0 and -0", () => {
    const zero = trade("alpha", 0, 0);
    const negativeZero = { ...zero, rMultiple: -0 };
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [zero, negativeZero, trade("alpha", 1, 1)],
      }),
      options(),
    );

    expect(result.windows[0].baselines.trust.ranking).toHaveLength(1);
    expect(result.windows[0].selectionMetrics[0].trade.trust?.sampleSize).toBe(2);
    expect(result.windows[0].leakageFindings).toContainEqual(
      expect.objectContaining({
        reason: "duplicate-observation-id",
        affectedIds: ["alpha-trade-0"],
      }),
    );
    expect(result.windows[0].leakageFindings).not.toContainEqual(
      expect.objectContaining({
        reason: "conflicting-duplicate-observation-id",
        affectedIds: ["alpha-trade-0"],
      }),
    );
  });

  it("does not misclassify repeated NaN evidence as a numeric conflict", () => {
    const invalid = trade("alpha", 0, Number.NaN);
    const result = evaluateForecasterBaselines(
      input({ tradeEvidence: [invalid, { ...invalid }] }),
      options(),
    );

    expect(result.windows[0].leakageFindings).not.toContainEqual(
      expect.objectContaining({
        reason: "conflicting-duplicate-observation-id",
        affectedIds: ["alpha-trade-0"],
      }),
    );
    expect(result.windows[0].exclusions.selection.historicalEvidence).toEqual([
      expect.objectContaining({ reasons: ["invalid-r-multiple"] }),
      expect.objectContaining({ reasons: ["invalid-r-multiple"] }),
    ]);
    expect(result.windows[0].baselines.trust.ranking).toEqual([]);
  });

  it("does not attach out-of-window duplicates or conflicts to an earlier window", () => {
    const future = trade("future", 0, 1, {
      resolutionTimestamp: 290,
      availabilityTimestamp: 300,
    });
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [
          future,
          { ...future },
          { ...future, rMultiple: 2 },
        ],
      }),
      options(),
    );

    const reasons = result.windows[0].leakageFindings.map(row => row.reason);
    expect(reasons).not.toContain("duplicate-observation-id");
    expect(reasons).not.toContain("conflicting-duplicate-observation-id");
    expect(result.windows[0].exclusions.selection.historicalEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observationId: "future-trade-0",
          reasons: expect.arrayContaining(["availability-after-cutoff"]),
        }),
      ]),
    );
  });

  it("reports timestamp errors and selection/evaluation ID overlap", () => {
    const supplied = evidenceFor(["alpha"]);
    const reused = trade("alpha", 0, 9, {
      resolutionTimestamp: 140,
      availabilityTimestamp: 150,
    });
    const invalid = forecast("bad", 0, 0.5, {
      forecastTimestamp: 90,
      resolutionTimestamp: 80,
      availabilityTimestamp: 70,
    });
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [...supplied.tradeEvidence, reused],
        forecastEvidence: [...supplied.forecastEvidence, invalid],
      }),
      options(),
    );
    const findings = result.windows[0].leakageFindings;

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "selection-evaluation-observation-overlap", affectedIds: ["alpha-trade-0"] }),
      expect.objectContaining({ reason: "incorrect-timestamp-ordering", affectedIds: ["bad-forecast-0"] }),
    ]));
  });

  it("reports overlapping windows and deterministic stability statistics", () => {
    const supplied = evidenceFor(["alpha", "bravo"]);
    const result = evaluateForecasterBaselines(
      input({
        windows: [
          { id: "later", selectionCutoff: 150, evaluationCutoff: 250 },
          { id: "earlier", selectionCutoff: 100, evaluationCutoff: 200 },
        ],
        ...supplied,
      }),
      options(),
    );

    expect(result.windows.map(row => row.window.id)).toEqual(["earlier", "later"]);
    expect(result.leakageFindings).toContainEqual(
      expect.objectContaining({
        reason: "overlapping-evaluation-windows",
        affectedIds: ["earlier", "later"],
      }),
    );
    expect(result.stability.transitions).toHaveLength(6);
    expect(result.stability.consistency).toHaveLength(6);
    expect(
      result.stability.transitions.find(row => row.strategy === "random-trade")
        ?.rankChanges,
    ).toEqual([]);
    expect(result.stability.inclusionFrequency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: "trust",
          forecasterId: "bravo",
          selectedWindows: 2,
          totalWindows: 2,
          frequency: 1,
        }),
      ]),
    );
  });

  it("measures selection turnover, inclusion frequency, and ranking changes", () => {
    const initial = evidenceFor(["alpha", "bravo"]);
    const laterTrades = [
      trade("alpha", 2, 2, { resolutionTimestamp: 110, availabilityTimestamp: 120 }),
      trade("alpha", 3, 3, { resolutionTimestamp: 120, availabilityTimestamp: 130 }),
    ];
    const result = evaluateForecasterBaselines(
      input({
        windows: [
          { id: "first", selectionCutoff: 100, evaluationCutoff: 180 },
          { id: "second", selectionCutoff: 150, evaluationCutoff: 230 },
        ],
        tradeEvidence: [...initial.tradeEvidence, ...laterTrades],
        forecastEvidence: initial.forecastEvidence,
      }),
      options(),
    );
    const transition = result.stability.transitions.find(
      row => row.strategy === "trust",
    );

    expect(result.windows[0].baselines.trust.selectedForecasterIds).toEqual([
      "bravo",
    ]);
    expect(result.windows[1].baselines.trust.selectedForecasterIds).toEqual([
      "alpha",
    ]);
    expect(transition).toMatchObject({
      retainedForecasterIds: [],
      addedForecasterIds: ["alpha"],
      removedForecasterIds: ["bravo"],
      overlap: 0,
    });
    expect(transition?.rankChanges).toEqual([
      { forecasterId: "alpha", previousRank: 2, currentRank: 1, delta: -1 },
      { forecasterId: "bravo", previousRank: 1, currentRank: 2, delta: 1 },
    ]);
  });

  it("marks an empty to eligible transition non-comparable", () => {
    const result = evaluateForecasterBaselines(
      input({
        windows: [
          { id: "empty", selectionCutoff: 100, evaluationCutoff: 110 },
          { id: "eligible", selectionCutoff: 150, evaluationCutoff: 160 },
        ],
        tradeEvidence: [
          trade("alpha", 0, 0, {
            resolutionTimestamp: 120,
            availabilityTimestamp: 130,
          }),
          trade("alpha", 1, 1, {
            resolutionTimestamp: 121,
            availabilityTimestamp: 131,
          }),
        ],
      }),
      options(),
    );
    const transition = result.stability.transitions.find(
      row => row.strategy === "trust",
    );
    const frequency = result.stability.inclusionFrequency.find(
      row => row.strategy === "trust" && row.forecasterId === "alpha",
    );

    expect(transition).toMatchObject({
      comparable: false,
      nonComparableReason: "from-window-not-evaluable",
      retainedForecasterIds: [],
      addedForecasterIds: [],
      removedForecasterIds: [],
      overlap: null,
    });
    expect(frequency).toMatchObject({
      selectedWindows: 1,
      totalWindows: 2,
      evaluableWindows: 1,
      insufficientWindows: 1,
      frequency: 1,
    });
  });

  it("marks an eligible to empty transition non-comparable", () => {
    const first = trade("alpha", 0, 0);
    const second = trade("alpha", 1, 1);
    const result = evaluateForecasterBaselines(
      input({
        windows: [
          { id: "eligible", selectionCutoff: 100, evaluationCutoff: 110 },
          { id: "empty", selectionCutoff: 150, evaluationCutoff: 160 },
        ],
        tradeEvidence: [
          first,
          second,
          { ...first, rMultiple: 4, resolutionTimestamp: 120, availabilityTimestamp: 130 },
          { ...second, rMultiple: 5, resolutionTimestamp: 121, availabilityTimestamp: 131 },
        ],
      }),
      options(),
    );
    const transition = result.stability.transitions.find(
      row => row.strategy === "trust",
    );

    expect(transition).toMatchObject({
      comparable: false,
      nonComparableReason: "to-window-not-evaluable",
      overlap: null,
    });
    expect(result.stability.nonComparableTransitions).toContainEqual({
      strategy: "trust",
      fromWindowId: "eligible",
      toWindowId: "empty",
      reason: "to-window-not-evaluable",
    });
  });

  it("marks an empty to empty transition non-comparable", () => {
    const result = evaluateForecasterBaselines(
      input({
        windows: [
          { id: "empty-1", selectionCutoff: 100, evaluationCutoff: 110 },
          { id: "empty-2", selectionCutoff: 150, evaluationCutoff: 160 },
        ],
      }),
      options(),
    );
    const transition = result.stability.transitions.find(
      row => row.strategy === "trust",
    );

    expect(transition).toMatchObject({
      comparable: false,
      nonComparableReason: "both-windows-not-evaluable",
      overlap: null,
    });
    expect(
      result.stability.consistency.find(row => row.strategy === "trust"),
    ).toMatchObject({
      comparableTransitions: 0,
      nonComparableTransitions: 1,
      meanOverlap: null,
    });
  });

  it("marks an insufficient to eligible transition non-comparable", () => {
    const result = evaluateForecasterBaselines(
      input({
        windows: [
          { id: "insufficient", selectionCutoff: 100, evaluationCutoff: 110 },
          { id: "eligible", selectionCutoff: 150, evaluationCutoff: 160 },
        ],
        tradeEvidence: [
          trade("alpha", 0, 0),
          trade("alpha", 1, 1, {
            resolutionTimestamp: 120,
            availabilityTimestamp: 130,
          }),
        ],
      }),
      options(),
    );

    expect(result.stability.insufficientWindows).toContainEqual({
      strategy: "trust",
      windowId: "insufficient",
      reason: "insufficient-evidence",
    });
    expect(
      result.stability.transitions.find(row => row.strategy === "trust"),
    ).toMatchObject({
      comparable: false,
      nonComparableReason: "from-window-not-evaluable",
      overlap: null,
    });
  });

  it("computes nontrivial Jaccard overlap and mean consistency", () => {
    const tradeEvidence: HistoricalTradeEvidence[] = [
      trade("a", 0, 0),
      trade("a", 1, 1),
      trade("b", 0, 1),
      trade("b", 1, 2),
      trade("c", 0, 2),
      trade("c", 1, 3),
      trade("d", 0, -2),
      trade("d", 1, -1),
    ];
    for (let index = 0; index < 12; index++)
      tradeEvidence.push(
        trade("a", index + 10, index % 2 === 0 ? 5 : 6, {
          resolutionTimestamp: 119,
          availabilityTimestamp: 120,
        }),
      );
    for (let index = 0; index < 16; index++)
      tradeEvidence.push(
        trade("d", index + 30, index % 2 === 0 ? 7 : 8, {
          resolutionTimestamp: 169,
          availabilityTimestamp: 170,
        }),
      );
    const result = evaluateForecasterBaselines(
      input({
        windows: [
          { id: "w1", selectionCutoff: 100, evaluationCutoff: 110 },
          { id: "w2", selectionCutoff: 150, evaluationCutoff: 160 },
          { id: "w3", selectionCutoff: 200, evaluationCutoff: 210 },
        ],
        tradeEvidence,
      }),
      options(),
    );
    const transitions = result.stability.transitions.filter(
      row => row.strategy === "trust",
    );

    expect(result.windows.map(row => row.baselines.trust.selectedForecasterIds))
      .toEqual([["c", "b"], ["a", "c"], ["a", "d"]]);
    expect(transitions.map(row => row.overlap)).toEqual([1 / 3, 1 / 3]);
    expect(transitions[0]).toMatchObject({
      retainedForecasterIds: ["c"],
      addedForecasterIds: ["a"],
      removedForecasterIds: ["b"],
      comparable: true,
    });
    expect(
      result.stability.consistency.find(row => row.strategy === "trust"),
    ).toEqual({
      strategy: "trust",
      comparableTransitions: 2,
      nonComparableTransitions: 0,
      meanOverlap: 1 / 3,
    });
  });

  it("diagnoses malformed evidence instead of allowing it into a ranking", () => {
    const malformedInput = input({
      tradeEvidence: [null as unknown as HistoricalTradeEvidence],
      forecastEvidence: [{} as HistoricalForecastEvidence],
    });
    const result = evaluateForecasterBaselines(malformedInput, options());

    expect(result.windows[0].selectionMetrics).toEqual([]);
    expect(result.windows[0].leakageFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "trade",
          reason: "malformed-evidence",
          affectedIds: ["<unknown>"],
        }),
        expect.objectContaining({
          category: "forecast",
          reason: "incorrect-timestamp-ordering",
          affectedIds: ["<unknown>"],
        }),
      ]),
    );
  });

  it("retains Day 8 structured selection and subsequent exclusions", () => {
    const result = evaluateForecasterBaselines(
      input({
        tradeEvidence: [trade("bad-trade", 0, Number.NaN)],
        forecastEvidence: [
          forecast("bad-probability", 0, 2),
          forecast("bad-outcome", 0, 0.5, { outcome: 2 as 0 | 1 }),
          forecast(" bad-id ", 0, 0.5),
          forecast("later-invalid", 0, -1, {
            forecastTimestamp: 110,
            resolutionTimestamp: 140,
            availabilityTimestamp: 150,
          }),
        ],
      }),
      options(),
    );
    const window = result.windows[0];
    const selectionExclusions = window.exclusions.selection.historicalEvidence;
    const subsequentExclusions =
      window.exclusions.subsequent.historicalEvidence;

    expect(selectionExclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observationId: "bad-trade-trade-0",
          reasons: ["invalid-r-multiple"],
        }),
        expect.objectContaining({
          observationId: "bad-probability-forecast-0",
          reasons: ["invalid-probability"],
        }),
        expect.objectContaining({
          observationId: "bad-outcome-forecast-0",
          reasons: ["invalid-outcome"],
        }),
        expect.objectContaining({
          forecasterId: " bad-id ",
          reasons: expect.arrayContaining([
            "invalid-forecaster-id",
            "invalid-id",
          ]),
        }),
      ]),
    );
    expect(subsequentExclusions).toContainEqual(
      expect.objectContaining({
        observationId: "later-invalid-forecast-0",
        reasons: ["invalid-probability"],
      }),
    );
    expect(window.baselines.trust.ranking).toEqual([]);
    expect(window.baselines.brier.ranking).toEqual([]);
  });

  it("is permutation invariant and never mutates caller input", () => {
    const supplied = evidenceFor(["alpha", "bravo", "charlie"]);
    const original = input(supplied);
    const snapshot = structuredClone(original);
    const forward = evaluateForecasterBaselines(original, options());
    const permuted = evaluateForecasterBaselines(
      input({
        windows: [...original.windows].reverse(),
        tradeEvidence: [...original.tradeEvidence].reverse(),
        forecastEvidence: [...original.forecastEvidence].reverse(),
      }),
      options(),
    );

    expect(permuted).toEqual(forward);
    expect(original).toEqual(snapshot);
  });

  it("validates windows and the deterministic random seed", () => {
    expect(() =>
      evaluateForecasterBaselines(input({ windows: [] }), options()),
    ).toThrow(/non-empty/);
    expect(() =>
      evaluateForecasterBaselines(
        input({
          windows: [{ id: "x", selectionCutoff: 100, evaluationCutoff: 100 }],
        }),
        options(),
      ),
    ).toThrow(/after/);
    expect(() =>
      evaluateForecasterBaselines(input(), options({ randomSeed: -1 })),
    ).toThrow(/unsigned 32-bit/);
  });
});
