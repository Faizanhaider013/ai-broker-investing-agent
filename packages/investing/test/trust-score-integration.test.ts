import { describe, expect, it } from "vitest";
import {
  computeBinaryForecastMetrics,
  computeForecasterTrustScore,
  evaluateForecasterBaselines,
  evaluateForecastersHistorically,
  reconstructResolvedPositions,
  rMultiplesFromResolvedPositions,
  selectEliteForecasters,
  settleResolvedPositions,
  type HistoricalForecastEvidence,
  type HistoricalTradeEvidence,
  type StoredTrade,
} from "../src/prediction";

// All records here are synthetic integration fixtures. They verify API
// composition and temporal behavior, not real-world predictive performance.
describe("TRUST Score public API integration", () => {
  it("composes reconstruction, settlement, R-multiples, and TRUST", () => {
    const trades: StoredTrade[] = [
      {
        traderId: "wallet",
        conditionId: "closed-win",
        type: "TRADE",
        side: "BUY",
        outcomeIndex: 0,
        size: 10,
        usdcSize: 4,
        timestamp: 10,
      },
      {
        traderId: "wallet",
        conditionId: "closed-win",
        type: "TRADE",
        side: "SELL",
        outcomeIndex: 0,
        size: 10,
        usdcSize: 10,
        timestamp: 20,
      },
      {
        traderId: "wallet",
        conditionId: "closed-loss",
        type: "TRADE",
        side: "BUY",
        outcomeIndex: 0,
        size: 10,
        usdcSize: 5,
        timestamp: 30,
      },
      {
        traderId: "wallet",
        conditionId: "closed-loss",
        type: "TRADE",
        side: "SELL",
        outcomeIndex: 0,
        size: 10,
        usdcSize: 2.5,
        timestamp: 40,
      },
      {
        traderId: "wallet",
        conditionId: "settled-win",
        type: "TRADE",
        side: "BUY",
        outcomeIndex: 0,
        size: 10,
        usdcSize: 4,
        timestamp: 45,
      },
    ];
    const reconstructed = reconstructResolvedPositions(trades);
    const settled = settleResolvedPositions(
      trades,
      new Map([
        ["settled-win", { winningOutcomeIndex: 0, resolvedAt: 60 }],
      ]),
    );
    const conversion = rMultiplesFromResolvedPositions(settled.positions, {
      cutoff: 60,
    });
    const trust = computeForecasterTrustScore(conversion.rMultiples, {
      minSampleSize: 3,
      ddof: 0,
    });

    expect(reconstructed.positions.map(row => row.resolved)).toEqual([
      true,
      true,
      false,
    ]);
    expect(settled.positions.map(row => row.closure)).toEqual([
      "sell-close",
      "sell-close",
      "settlement",
    ]);
    expect(conversion.rMultiples).toEqual([1.5, -0.5, 1.5]);
    expect(trust).toMatchObject({
      sampleSize: 3,
      hasSufficientSample: true,
      reliable: true,
      reason: "ok",
    });
  });

  it("keeps forecast, historical, and baseline categories separate over time", () => {
    const tradeEvidence: HistoricalTradeEvidence[] = [
      { id: "alpha-t1", forecasterId: "alpha", rMultiple: 0, resolutionTimestamp: 70, availabilityTimestamp: 80 },
      { id: "alpha-t2", forecasterId: "alpha", rMultiple: 1, resolutionTimestamp: 71, availabilityTimestamp: 81 },
      { id: "beta-t1", forecasterId: "beta", rMultiple: 1, resolutionTimestamp: 70, availabilityTimestamp: 80 },
      { id: "beta-t2", forecasterId: "beta", rMultiple: 2, resolutionTimestamp: 71, availabilityTimestamp: 81 },
      { id: "alpha-t3", forecasterId: "alpha", rMultiple: -1, resolutionTimestamp: 130, availabilityTimestamp: 140 },
      { id: "alpha-t4", forecasterId: "alpha", rMultiple: 1, resolutionTimestamp: 131, availabilityTimestamp: 141 },
    ];
    const forecastEvidence: HistoricalForecastEvidence[] = [
      { id: "alpha-f1", forecasterId: "alpha", eventId: "a1", probabilityYes: 0.9, forecastTimestamp: 20, outcome: 1, resolutionTimestamp: 70, availabilityTimestamp: 80 },
      { id: "alpha-f2", forecasterId: "alpha", eventId: "a2", probabilityYes: 0.8, forecastTimestamp: 21, outcome: 1, resolutionTimestamp: 71, availabilityTimestamp: 81 },
      { id: "beta-f1", forecasterId: "beta", eventId: "b1", probabilityYes: 0.8, forecastTimestamp: 20, outcome: 1, resolutionTimestamp: 70, availabilityTimestamp: 80 },
      { id: "beta-f2", forecasterId: "beta", eventId: "b2", probabilityYes: 0.7, forecastTimestamp: 21, outcome: 1, resolutionTimestamp: 71, availabilityTimestamp: 81 },
      { id: "alpha-f3", forecasterId: "alpha", eventId: "a3", probabilityYes: 0.1, forecastTimestamp: 110, outcome: 0, resolutionTimestamp: 130, availabilityTimestamp: 140 },
      { id: "alpha-f4", forecasterId: "alpha", eventId: "a4", probabilityYes: 0.9, forecastTimestamp: 111, outcome: 1, resolutionTimestamp: 131, availabilityTimestamp: 141 },
    ];
    const selectionOptions = {
      trade: { minSampleSize: 2, topFraction: 1, ddof: 0 as const },
      forecast: { minSampleSize: 2, brierScoreThreshold: 0.15 },
    };
    const directMetrics = computeBinaryForecastMetrics(
      forecastEvidence.slice(0, 2),
      { cutoff: 100, expectedForecasterId: "alpha" },
    );
    const elite = selectEliteForecasters(
      [
        {
          forecasterId: "alpha",
          tradeObservations: tradeEvidence.slice(0, 2),
          forecastObservations: forecastEvidence.slice(0, 2),
        },
        {
          forecasterId: "beta",
          tradeObservations: tradeEvidence.slice(2, 4),
          forecastObservations: forecastEvidence.slice(2, 4),
        },
      ],
      { cutoff: 100, ...selectionOptions },
    );
    const historical = evaluateForecastersHistorically(
      {
        cutoffs: [200, 100],
        tradeEvidence,
        forecastEvidence,
        coverage: { tradeHistory: "complete", forecastHistory: "complete" },
      },
      { selection: selectionOptions },
    );
    const baselines = evaluateForecasterBaselines(
      {
        windows: [{ id: "forward", selectionCutoff: 100, evaluationCutoff: 200 }],
        tradeEvidence,
        forecastEvidence,
        coverage: { tradeHistory: "complete", forecastHistory: "complete" },
      },
      { randomSeed: 7, selection: selectionOptions },
    );

    expect(directMetrics.sampleSize).toBe(2);
    expect(directMetrics.brierScore).toBeCloseTo(0.025);
    expect(elite.tradeRanking.map(row => row.forecasterId)).toEqual([
      "beta",
      "alpha",
    ]);
    expect(elite.forecastRanking.map(row => row.forecasterId)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(historical.evaluations.map(row => row.cutoff)).toEqual([100, 200]);
    expect(
      historical.evaluations.map(row =>
        row.forecasters.find(item => item.forecasterId === "alpha")?.trade.trust
          ?.sampleSize,
      ),
    ).toEqual([2, 4]);
    const window = baselines.windows[0];
    expect(window.baselines.trust.candidatePool).toEqual(["beta", "alpha"]);
    expect(window.baselines.brier.candidatePool).toEqual(["alpha", "beta"]);
    expect(window.subsequentOutcomes.trust.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          forecasterId: "alpha",
          status: "evaluated",
          hasSufficientSample: true,
        }),
        expect.objectContaining({
          forecasterId: "beta",
          status: "missing-subsequent-evidence",
        }),
      ]),
    );
    expect(window.leakageFindings.map(row => row.reason)).toEqual(
      expect.arrayContaining([
        "trade-resolved-after-selection-cutoff",
        "forecast-resolved-after-selection-cutoff",
        "availability-after-selection-cutoff",
      ]),
    );
  });
});
