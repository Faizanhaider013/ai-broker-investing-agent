import { describe, expect, it } from "vitest";

import {
  ALLOWED_IMPORTS,
  actionableFindings,
  checkConformance,
  extractImportSpecifiers,
  stripBlockComments,
  stripComments,
  type ConformanceFinding,
} from "../scripts/pine-conformance";

// A conformant, signal-only port: every required export, approved imports only,
// pure (timestamp from the bar's own date), a warm-up window and HOLD literal.
const GOOD_PORT = [
  'import type { TradeSignal } from "@/trading-agents/types";',
  'import type { HistoricalQuote } from "@/stocks/quote-cache-service";',
  "",
  "export interface ProbeConfig { period: number; warmupBars: number; }",
  "export const DEFAULT_PROBE_CONFIG: ProbeConfig = { period: 5, warmupBars: 5 };",
  'export type ProbeBar = Pick<HistoricalQuote, "date" | "close">;',
  "export function normalizeProbeConfig(c: Partial<ProbeConfig> = {}): ProbeConfig {",
  "  return { ...DEFAULT_PROBE_CONFIG, ...c };",
  "}",
  "export function evaluateProbe(bars: readonly ProbeBar[]): TradeSignal[] {",
  "  const { warmupBars } = normalizeProbeConfig();",
  "  return bars.map((b, i) => ({",
  '    action: (i + 1 >= warmupBars ? "HOLD" : "HOLD") as const,',
  "    confidence: 0,",
  '    reasoning: "warm-up",',
  "    timestamp: new Date(b.date),",
  "  }));",
  "}",
  "",
].join("\n");

const ids = (findings: ConformanceFinding[]) => findings.map((f) => f.id);

describe("comment stripping", () => {
  it("removes block/JSDoc comments so prose never trips an impurity check", () => {
    const src = [
      "/**",
      " * This is pure and offline: no network, no Date.now(), no randomness.",
      " */",
      "export const x = 1;",
    ].join("\n");
    const stripped = stripBlockComments(src);
    expect(stripped).not.toContain("Date.now(");
    expect(stripped).toContain("export const x = 1;");
  });

  it("keeps block-comment-like sequences that live inside a string literal", () => {
    const src = 'const s = "a /* not a comment */ b";';
    expect(stripBlockComments(src)).toBe(src);
  });

  it("stripComments also removes // line comments", () => {
    expect(stripComments("const a = 1; // Math.random() mentioned here")).not.toContain("Math.random(");
  });
});

describe("extractImportSpecifiers", () => {
  it("collects static and side-effect import specifiers", () => {
    const code = [
      'import type { TradeSignal } from "@/trading-agents/types";',
      'import { foo } from "../internal/foo";',
      'import "node:fs";',
    ].join("\n");
    expect(extractImportSpecifiers(code).sort()).toEqual(
      ["../internal/foo", "@/trading-agents/types", "node:fs"].sort(),
    );
  });
});

describe("checkConformance — positive fixture", () => {
  it("passes a conformant port with no findings", () => {
    const result = checkConformance(GOOD_PORT, {
      unrepresentableFeatures: [],
      declaredUnsupported: [],
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("does not flag a docstring that merely describes purity", () => {
    const withDocstring = [
      "/**",
      " * Pure and offline: no network, no Date.now(), no Math.random(), no fetch().",
      " */",
      GOOD_PORT,
    ].join("\n");
    const result = checkConformance(withDocstring);
    expect(result.ok).toBe(true);
    expect(ids(result.findings)).not.toContain("impurity:date-now");
    expect(ids(result.findings)).not.toContain("impurity:math-random");
    expect(ids(result.findings)).not.toContain("impurity:fetch");
  });
});

describe("checkConformance — missing exports", () => {
  it("flags every absent required export as an error", () => {
    const result = checkConformance(
      'import type { TradeSignal } from "@/trading-agents/types";\nexport const nothing = 1;\n',
    );
    expect(result.ok).toBe(false);
    expect(ids(result.findings)).toEqual(
      expect.arrayContaining([
        "missing-export:evaluate-fn",
        "missing-export:config-interface",
        "missing-export:default-config",
        "missing-export:bar-type",
        "missing-export:normalize-fn",
      ]),
    );
  });

  it("does not require exact strategy names (any <Name> satisfies the shape)", () => {
    const result = checkConformance(GOOD_PORT);
    expect(ids(result.findings).some((id) => id.startsWith("missing-export"))).toBe(false);
  });
});

describe("checkConformance — disallowed imports", () => {
  it("flags node builtins, npm packages and relative reach-ins but not approved aliases", () => {
    const code = [
      'import type { TradeSignal } from "@/trading-agents/types";',
      'import { readFileSync } from "node:fs";',
      'import dayjs from "dayjs";',
      'import { helper } from "../../utils/helper";',
      GOOD_PORT,
    ].join("\n");
    const result = checkConformance(code);
    const disallowed = result.findings.filter((f) => f.id === "disallowed-import");
    expect(disallowed).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(disallowed.map((f) => f.message).join(" ")).toContain("node:fs");
    expect(disallowed.map((f) => f.message).join(" ")).toContain("dayjs");
    expect(disallowed.map((f) => f.message).join(" ")).toContain("../../utils/helper");
  });

  it("treats both approved aliases as allowed", () => {
    expect(ALLOWED_IMPORTS).toContain("@/trading-agents/types");
    expect(ALLOWED_IMPORTS).toContain("@/stocks/quote-cache-service");
    const result = checkConformance(GOOD_PORT);
    expect(result.findings.some((f) => f.id === "disallowed-import")).toBe(false);
  });
});

describe("checkConformance — impurity", () => {
  it("flags Date.now(), Math.random() and fetch() as errors", () => {
    const code = [
      'import type { TradeSignal } from "@/trading-agents/types";',
      "export function evaluateX(bars: readonly { date: string }[]): TradeSignal[] {",
      "  const r = Math.random();",
      "  const t = Date.now();",
      '  void fetch("https://example.com");',
      "  return [];",
      "}",
      "export interface XConfig { warmupBars: number; }",
      "export const DEFAULT_X_CONFIG: XConfig = { warmupBars: 1 };",
      "export type XBar = { date: string };",
      "export function normalizeXConfig(c: Partial<XConfig> = {}): XConfig { return { ...DEFAULT_X_CONFIG, ...c }; }",
      '// returns no "HOLD" guard on purpose? it has warmupBars so warm-up heuristic is satisfied',
    ].join("\n");
    const result = checkConformance(code);
    expect(result.ok).toBe(false);
    expect(ids(result.findings)).toEqual(
      expect.arrayContaining(["impurity:date-now", "impurity:math-random", "impurity:fetch"]),
    );
    // Every impurity finding here is actionable (error severity).
    expect(actionableFindings(result).length).toBeGreaterThanOrEqual(3);
  });

  it("warns (not errors) on a bare new Date() wall-clock construction", () => {
    const code = [GOOD_PORT, "export const now = new Date();"].join("\n");
    const result = checkConformance(code);
    const finding = result.findings.find((f) => f.id === "impurity:wallclock-date");
    expect(finding?.severity).toBe("warn");
    // A lone warning must not fail the result.
    expect(result.ok).toBe(true);
  });

  it("does not flag new Date(bar.date) with an argument", () => {
    const result = checkConformance(GOOD_PORT);
    expect(result.findings.some((f) => f.id === "impurity:wallclock-date")).toBe(false);
  });

  it("does not flag impurity patterns that appear only in comments", () => {
    const code = [GOOD_PORT, "// historically this used Math.random() and Date.now()"].join("\n");
    const result = checkConformance(code);
    expect(ids(result.findings)).not.toContain("impurity:math-random");
    expect(ids(result.findings)).not.toContain("impurity:date-now");
  });
});

describe("checkConformance — warm-up heuristic", () => {
  it("warns when neither a warm-up concept nor a HOLD literal is present", () => {
    const code = [
      'import type { TradeSignal } from "@/trading-agents/types";',
      "export interface YConfig { period: number; }",
      "export const DEFAULT_Y_CONFIG: YConfig = { period: 5 };",
      "export type YBar = { date: string };",
      "export function normalizeYConfig(c: Partial<YConfig> = {}): YConfig { return { ...DEFAULT_Y_CONFIG, ...c }; }",
      "export function evaluateY(bars: readonly YBar[]): TradeSignal[] { return []; }",
    ].join("\n");
    const result = checkConformance(code);
    const finding = result.findings.find((f) => f.id === "missing-warmup-guard");
    expect(finding?.severity).toBe("warn");
    expect(result.ok).toBe(true); // heuristic warning only
  });

  it("is satisfied by a HOLD literal alone", () => {
    expect(checkConformance(GOOD_PORT).findings.some((f) => f.id === "missing-warmup-guard")).toBe(
      false,
    );
  });
});

describe("checkConformance — unsupported-feature cross-check", () => {
  it("warns when a source unrepresentable feature has no matching @unsupported marker", () => {
    const result = checkConformance(GOOD_PORT, {
      unrepresentableFeatures: ["trailingStop", "pyramiding"],
      declaredUnsupported: [],
    });
    expect(result.ok).toBe(true); // all warnings, never errors
    expect(ids(result.findings)).toEqual(
      expect.arrayContaining([
        "undeclared-unsupported:trailingStop",
        "undeclared-unsupported:pyramiding",
      ]),
    );
  });

  it("is satisfied by a keyword-matching marker, regardless of exact wording", () => {
    const result = checkConformance(GOOD_PORT, {
      unrepresentableFeatures: ["trailingStop"],
      declaredUnsupported: ["ATR trailing stop - no price field in TradeSignal"],
    });
    expect(result.findings.some((f) => f.id.startsWith("undeclared-unsupported"))).toBe(false);
  });

  it("flags one feature while acknowledging another in the same run", () => {
    const result = checkConformance(GOOD_PORT, {
      unrepresentableFeatures: ["trailingStop", "positionSizing"],
      declaredUnsupported: ["position sizing cannot be carried"],
    });
    const flagged = ids(result.findings).filter((id) => id.startsWith("undeclared-unsupported"));
    expect(flagged).toEqual(["undeclared-unsupported:trailingStop"]);
  });

  it("does not treat an absent marker as proof of support (always surfaces it)", () => {
    const result = checkConformance(GOOD_PORT, {
      unrepresentableFeatures: ["stopLoss"],
      declaredUnsupported: ["something unrelated"],
    });
    expect(ids(result.findings)).toContain("undeclared-unsupported:stopLoss");
  });
});

describe("checkConformance — structure and determinism", () => {
  it("returns findings in a fixed order (exports, imports, impurity, warm-up, unsupported)", () => {
    const code = [
      'import { x } from "lodash";',
      "export const y = Math.random();",
    ].join("\n");
    const result = checkConformance(code, { unrepresentableFeatures: ["stopLoss"] });
    const order = ids(result.findings);
    const firstExport = order.findIndex((id) => id.startsWith("missing-export"));
    const firstImport = order.indexOf("disallowed-import");
    const firstImpurity = order.findIndex((id) => id.startsWith("impurity:"));
    const firstUnsupported = order.findIndex((id) => id.startsWith("undeclared-unsupported"));
    expect(firstExport).toBeGreaterThanOrEqual(0);
    expect(firstExport).toBeLessThan(firstImport);
    expect(firstImport).toBeLessThan(firstImpurity);
    expect(firstImpurity).toBeLessThan(firstUnsupported);
  });

  it("is deterministic: identical input yields identical output", () => {
    const ctx = { unrepresentableFeatures: ["trailingStop"], declaredUnsupported: [] };
    expect(JSON.stringify(checkConformance(GOOD_PORT, ctx))).toBe(
      JSON.stringify(checkConformance(GOOD_PORT, ctx)),
    );
  });

  it("every finding carries a stable id and a severity", () => {
    const result = checkConformance('import "x";\nexport const bad = 1;\n', {
      unrepresentableFeatures: ["pyramiding"],
    });
    for (const f of result.findings) {
      expect(typeof f.id).toBe("string");
      expect(f.id.length).toBeGreaterThan(0);
      expect(["error", "warn"]).toContain(f.severity);
      expect(typeof f.message).toBe("string");
    }
  });
});
