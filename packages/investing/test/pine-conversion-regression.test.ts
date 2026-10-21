import { describe, expect, it } from "vitest";

import {
  assertConvertible,
  buildConversionPrompt,
  detectPineVersion,
  runConversion,
  type CatalogEntry,
} from "../scripts/pine-convert";
import { checkConformance, type ConformanceContext } from "../scripts/pine-conformance";
import { detectUnrepresentableFeatures } from "../scripts/pine-features";

const SMA_CROSSOVER = [
  "//@version=5",
  'strategy("SMA crossover")',
  "fast = ta.sma(close, 9)",
  "slow = ta.sma(close, 21)",
  "if ta.crossover(fast, slow)",
  '    strategy.entry("Long", strategy.long)',
].join("\n");

const RSI_SIGNALS = [
  "//@version=6",
  'strategy("RSI signals")',
  "rsiValue = ta.rsi(close, 14)",
  "if rsiValue < 30",
  '    strategy.entry("Long", strategy.long)',
].join("\n");

const BOLLINGER_CONDITIONS = [
  "//@version=5",
  'strategy("Bollinger conditions")',
  "basis = ta.sma(close, 20)",
  "dev = 2.0 * ta.stdev(close, 20)",
  "if close < basis - dev",
  '    strategy.entry("Long", strategy.long)',
].join("\n");

const WARMUP_LOOKBACK = [
  "//@version=6",
  'strategy("Long lookback")',
  "trend = ta.sma(close, 200)",
  "if bar_index >= 200 and close > trend",
  '    strategy.entry("Long", strategy.long)',
].join("\n");

const UNSUPPORTED_FEATURES = [
  "//@version=5",
  'strategy("Unsupported", default_qty_type = strategy.percent_of_equity, default_qty_value = 10)',
  'higherClose = request.security(syminfo.tickerid, "D", close)',
  'strategy.entry("Long", strategy.long)',
  'strategy.exit("Exit", "Long", trail_points = 10)',
].join("\n");

const MINIMAL_STRATEGY = "//@version=5\nstrategy(\"Minimal\")";

const STRUCTURED_PORT_WITHOUT_WARMUP = [
  'import type { TradeSignal } from "@/trading-agents/types";',
  "export interface ProbeConfig { period: number; }",
  "export const DEFAULT_PROBE_CONFIG: ProbeConfig = { period: 5 };",
  "export type ProbeBar = { date: string; close: number };",
  "export function normalizeProbeConfig(c: Partial<ProbeConfig> = {}): ProbeConfig { return { ...DEFAULT_PROBE_CONFIG, ...c }; }",
  "export function evaluateProbe(_bars: readonly ProbeBar[]): TradeSignal[] { return []; }",
].join("\n");

const STRUCTURED_PORT_WITH_WARMUP = STRUCTURED_PORT_WITHOUT_WARMUP.replace(
  "period: number;",
  "period: number; warmupBars: number;",
).replace(
  "{ period: 5 }",
  "{ period: 5, warmupBars: 5 }",
);

describe("Pine conversion regression fixtures", () => {
  it("accepts small SMA, RSI, Bollinger, and long-lookback strategies with their declared versions", () => {
    expect(detectPineVersion(SMA_CROSSOVER)).toBe(5);
    expect(detectPineVersion(RSI_SIGNALS)).toBe(6);
    expect(detectPineVersion(BOLLINGER_CONDITIONS)).toBe(5);
    expect(assertConvertible({ url: "warmup", source: WARMUP_LOOKBACK })).toBe(6);
  });

  it("builds a conversion prompt that carries the source and required signal-only constraints", () => {
    const entry: CatalogEntry = { url: "sma-crossover", name: "SMA crossover", source: SMA_CROSSOVER };
    const prompt = buildConversionPrompt(entry, 5);

    expect(prompt.user).toContain(SMA_CROSSOVER);
    expect(prompt.user).toContain("Pine Script v5");
    expect(prompt.system).toContain("evaluate<Name>");
    expect(prompt.system).toContain("warm-up");
    expect(prompt.system).toContain("@unsupported:");
  });

  it("rejects empty, versionless, unsupported-version, and indicator-only inputs at conversion guards", () => {
    expect(() => assertConvertible({ url: "empty", source: "   " })).toThrow(/empty source/);
    expect(() => detectPineVersion('strategy("No version")')).toThrow(/Could not detect/);
    expect(() => detectPineVersion("//@version=4\nstrategy(\"Old\")")).toThrow(/Unsupported Pine Script version 4/);
    expect(() => assertConvertible({ url: "indicator", source: "//@version=5\nindicator(\"Only plots\")" })).toThrow(
      /not a strategy/,
    );
    expect(assertConvertible({ url: "minimal", source: MINIMAL_STRATEGY })).toBe(5);
  });

  it("detects the exact unrepresentable source features without treating comments as features", () => {
    expect(detectUnrepresentableFeatures(UNSUPPORTED_FEATURES)).toEqual([
      "trailingStop",
      "requestSecurity",
      "positionSizing",
      "strategyExit",
    ]);
    expect(detectUnrepresentableFeatures("// strategy.exit(\"ignored\")\n" + MINIMAL_STRATEGY)).toEqual([]);
  });
});

describe("Pine conversion conformance regression fixtures", () => {
  it("reports the missing warm-up guard as a warning for a structurally valid port", () => {
    const result = checkConformance(STRUCTURED_PORT_WITHOUT_WARMUP);
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "missing-warmup-guard", severity: "warn" }),
      ]),
    );
  });

  it("recognizes an explicit warm-up configuration and cross-checks unsupported declarations", () => {
    const sourceFeatures = detectUnrepresentableFeatures(UNSUPPORTED_FEATURES);
    const withoutDeclarations = checkConformance(STRUCTURED_PORT_WITH_WARMUP, {
      unrepresentableFeatures: sourceFeatures,
      declaredUnsupported: [],
    });
    expect(withoutDeclarations.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "undeclared-unsupported:trailingStop", severity: "warn" }),
        expect.objectContaining({ id: "undeclared-unsupported:requestSecurity", severity: "warn" }),
        expect.objectContaining({ id: "undeclared-unsupported:positionSizing", severity: "warn" }),
        expect.objectContaining({ id: "undeclared-unsupported:strategyExit", severity: "warn" }),
      ]),
    );

    const withDeclarations = checkConformance(STRUCTURED_PORT_WITH_WARMUP, {
      unrepresentableFeatures: sourceFeatures,
      declaredUnsupported: [
        "trailing stop cannot be represented",
        "request.security cannot be represented",
        "position sizing cannot be represented",
        "strategy.exit cannot be represented",
      ],
    });
    expect(withDeclarations.findings.some((finding) => finding.id.startsWith("undeclared-unsupported:"))).toBe(false);
  });
});

describe("Pine conversion orchestration regression fixture", () => {
  it("passes detected unsupported features into injected conformance and returns its structured findings", async () => {
    const catalog: CatalogEntry[] = [{ url: "unsupported", name: "Unsupported", source: UNSUPPORTED_FEATURES }];
    const contexts: ConformanceContext[] = [];
    let invocations = 0;
    let validations = 0;
    let writes = 0;

    const report = await runConversion({
      url: "unsupported",
      catalog,
      invoke: async () => {
        invocations += 1;
        return "```ts\nexport const evaluateUnsupported = () => [];\n```";
      },
      validate: () => {
        validations += 1;
        return { ok: true, errors: [] };
      },
      writeAttempt: (_slug, _attempt, _code) => {
        writes += 1;
        return "mem://unsupported.attempt-0.ts";
      },
      analyzeFeatures: detectUnrepresentableFeatures,
      conformanceCheck: (_code, context) => {
        contexts.push(context);
        return {
          ok: true,
          findings: [{ id: "fixture:unsupported-context", severity: "warn", message: "checked in memory" }],
        };
      },
    });

    expect(invocations).toBe(1);
    expect(validations).toBe(1);
    expect(writes).toBe(1);
    expect(contexts[0].unrepresentableFeatures).toEqual([
      "trailingStop",
      "requestSecurity",
      "positionSizing",
      "strategyExit",
    ]);
    expect(report.validationStatus).toBe("passed");
    expect(report.conformance).toEqual({
      status: "passed",
      findings: [{ id: "fixture:unsupported-context", severity: "warn", message: "checked in memory" }],
    });
    expect(report.stagedFile).toBe("mem://unsupported.attempt-0.ts");
  });
});
