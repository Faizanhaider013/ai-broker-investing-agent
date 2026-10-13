import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  PACKAGE_ROOT,
  STAGING_DIR,
  MAX_REPAIRS,
  type CatalogEntry,
  type ConversionPrompt,
  type ValidationResult,
  loadCatalog,
  selectStrategyByUrl,
  detectPineVersion,
  assertConvertible,
  slugFromUrl,
  extractTypeScript,
  parseUnsupportedFeatures,
  buildConversionPrompt,
  buildRepairPrompt,
  buildValidationTsconfig,
  filterTscDiagnostics,
  writeStagedFile,
  tscValidator,
  interpretTscResult,
  runConversion,
  planDryRun,
} from "../scripts/pine-convert";

// A tiny inline catalog so selection tests don't depend on the 2.8 MB file.
const CATALOG: CatalogEntry[] = [
  {
    url: "aaa-strategy-one",
    name: "Strategy One",
    script_type: "strategy",
    source: "//@version=5\nstrategy('One')\nif close > open\n    strategy.entry('L', strategy.long)",
  },
  {
    url: "bbb-strategy-two",
    name: "Strategy Two",
    source: "//@version=6\nstrategy('Two')",
  },
  {
    url: "ccc-indicator",
    name: "Just An Indicator",
    source: "//@version=5\nindicator('Ind')\nplot(close)",
  },
  { url: "ddd-empty", name: "Empty Source", source: "   " },
];

const TEST_STAGING = path.join(STAGING_DIR, "_test");
afterAll(() => {
  fs.rmSync(TEST_STAGING, { recursive: true, force: true });
  // Remove the staging root too, but only if nothing else left output there.
  try {
    if (fs.readdirSync(STAGING_DIR).length === 0) fs.rmdirSync(STAGING_DIR);
  } catch {
    /* staging dir already gone or non-empty — leave it */
  }
});

describe("catalog selection", () => {
  it("selects a strategy by its unique url", () => {
    expect(selectStrategyByUrl(CATALOG, "bbb-strategy-two").name).toBe("Strategy Two");
  });

  it("throws for an unknown url", () => {
    expect(() => selectStrategyByUrl(CATALOG, "does-not-exist")).toThrow(/No catalog entry/);
  });

  it("throws for an empty url (never falls back to name)", () => {
    expect(() => selectStrategyByUrl(CATALOG, "")).toThrow(/non-empty --url/);
  });

  it("throws when a url is not unique", () => {
    const dup = [...CATALOG, { url: "aaa-strategy-one", source: "//@version=5\nstrategy('dup')" }];
    expect(() => selectStrategyByUrl(dup, "aaa-strategy-one")).toThrow(/expected unique/);
  });

  it("loads the committed catalog and finds the real EMA entry", () => {
    const catalog = loadCatalog();
    const ema = catalog.find((e) => e.url.includes("fURZdvM1"));
    expect(ema).toBeTruthy();
    expect(assertConvertible(ema as CatalogEntry)).toBe(6);
  });
});

describe("version detection", () => {
  it("detects v5 and v6", () => {
    expect(detectPineVersion("//@version=5\nstrategy('x')")).toBe(5);
    expect(detectPineVersion("//@version=6\nstrategy('x')")).toBe(6);
    expect(detectPineVersion("// @version = 5 ")).toBe(5);
  });

  it("throws when no version tag is present", () => {
    expect(() => detectPineVersion("strategy('x')")).toThrow(/Could not detect/);
  });

  it("throws on an unsupported version", () => {
    expect(() => detectPineVersion("//@version=4\nstrategy('x')")).toThrow(/Unsupported Pine Script version 4/);
  });
});

describe("convertibility guards", () => {
  it("accepts a well-formed strategy and returns its version", () => {
    expect(assertConvertible(CATALOG[0])).toBe(5);
    expect(assertConvertible(CATALOG[1])).toBe(6);
  });

  it("rejects an empty source", () => {
    expect(() => assertConvertible(CATALOG[3])).toThrow(/empty source/);
  });

  it("rejects a non-strategy (indicator) script", () => {
    expect(() => assertConvertible(CATALOG[2])).toThrow(/not a strategy/);
  });
});

describe("slug + code extraction", () => {
  it("builds a filesystem-safe slug", () => {
    expect(slugFromUrl("ABC/def_123-XY")).toBe("abc-def-123-xy");
    expect(slugFromUrl("")).toBe("strategy");
  });

  it("strips a ```ts fence and trailing/leading whitespace", () => {
    expect(extractTypeScript("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(extractTypeScript("```typescript\nconst b = 2;\n```")).toBe("const b = 2;\n");
  });

  it("returns bare text unchanged when there is no fence", () => {
    expect(extractTypeScript("const c = 3;")).toBe("const c = 3;\n");
  });

  it("extracts @unsupported feature markers and ignores 'none'", () => {
    const text = [
      "// @unsupported: ATR trailing stop - no price field in TradeSignal",
      "// @unsupported: position sizing - no quantity field",
      "const x = 1;",
    ].join("\n");
    expect(parseUnsupportedFeatures(text)).toEqual([
      "ATR trailing stop - no price field in TradeSignal",
      "position sizing - no quantity field",
    ]);
    expect(parseUnsupportedFeatures("// @unsupported: none")).toEqual([]);
    expect(parseUnsupportedFeatures("const y = 2;")).toEqual([]);
  });
});

describe("prompt generation", () => {
  const prompt = buildConversionPrompt(CATALOG[0], 5);

  it("embeds the source, version, contract, test expectations, and unsupported rules", () => {
    expect(prompt.user).toContain(CATALOG[0].source as string);
    expect(prompt.user).toContain("Pine Script v5");
    expect(prompt.user).toContain(CATALOG[0].url);
    expect(prompt.system).toContain("TradeSignal");
    expect(prompt.system).toContain("@unsupported:");
    expect(prompt.system).toContain("evaluate<Name>");
    expect(prompt.system).toContain("deterministic");
  });

  it("builds a repair prompt carrying the errors and previous code", () => {
    const repair = buildRepairPrompt(CATALOG[0], 5, "const bad = 1", ["file.ts(1,1): error TS1005"]);
    expect(repair.system).toBe(prompt.system); // same reusable template
    expect(repair.user).toContain("error TS1005");
    expect(repair.user).toContain("const bad = 1");
    expect(repair.user).toContain("failed static validation");
  });
});

describe("tsc diagnostic filtering", () => {
  it("keeps only lines referring to the staged file", () => {
    const staged = path.join(STAGING_DIR, "foo", "bar.attempt-0.ts");
    const output = [
      "src/alpaca/alpaca-mcp-client.ts(111,23): error TS18046: 'error' is of type 'unknown'.",
      ".pine-convert/foo/bar.attempt-0.ts(2,14): error TS2322: not assignable.",
      "src/stocks/unified-quote-service.ts(109,35): error TS2740: missing props.",
    ].join("\n");
    const kept = filterTscDiagnostics(output, staged);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("bar.attempt-0.ts(2,14)");
  });

  it("returns [] when no diagnostics mention the staged file", () => {
    const staged = path.join(STAGING_DIR, "foo", "bar.attempt-0.ts");
    expect(filterTscDiagnostics("src/x.ts(1,1): error TS1.", staged)).toEqual([]);
  });

  it("builds a validation tsconfig that extends the package config and widens rootDir", () => {
    const staged = path.join(STAGING_DIR, "foo", "bar.ts");
    const cfg = buildValidationTsconfig(staged) as any;
    expect(cfg.extends).toBe(path.join(PACKAGE_ROOT, "tsconfig.json"));
    expect(cfg.compilerOptions.noEmit).toBe(true);
    expect(cfg.compilerOptions.rootDir).toBe(PACKAGE_ROOT);
    expect(cfg.include).toEqual([staged]);
  });
});

describe("writeStagedFile never overwrites", () => {
  it("writes a new file but throws if it already exists", () => {
    const target = path.join(TEST_STAGING, "overwrite", "s.ts");
    expect(writeStagedFile(target, "a\n")).toBe(target);
    expect(fs.readFileSync(target, "utf8")).toBe("a\n");
    expect(() => writeStagedFile(target, "b\n")).toThrow(); // EEXIST from flag "wx"
    expect(fs.readFileSync(target, "utf8")).toBe("a\n"); // unchanged
  });
});

describe("runConversion repair loop (injected invoke + validate)", () => {
  // In-memory writer so the loop never touches the filesystem.
  const memWriter = () => (slug: string, attempt: number) => `mem://${slug}.attempt-${attempt}.ts`;
  const okCode = "```ts\nexport const evaluateX = () => [];\n```";

  it("succeeds on the first attempt with no repairs", async () => {
    let calls = 0;
    const report = await runConversion({
      url: "aaa-strategy-one",
      catalog: CATALOG,
      invoke: async () => { calls++; return okCode; },
      validate: () => ({ ok: true, errors: [] }),
      writeAttempt: memWriter(),
    });
    expect(calls).toBe(1);
    expect(report.attempts).toBe(1);
    expect(report.repairAttempts).toBe(0);
    expect(report.validationStatus).toBe("passed");
    expect(report.version).toBe(5);
    expect(report.name).toBe("Strategy One");
  });

  it("succeeds after a single repair", async () => {
    let calls = 0;
    const report = await runConversion({
      url: "aaa-strategy-one",
      catalog: CATALOG,
      invoke: async () => { calls++; return okCode; },
      validate: () => ({ ok: calls > 1, errors: calls > 1 ? [] : ["err"] }),
      writeAttempt: memWriter(),
    });
    expect(calls).toBe(2);
    expect(report.attempts).toBe(2);
    expect(report.repairAttempts).toBe(1);
    expect(report.validationStatus).toBe("passed");
  });

  it("defaults the repair budget to three", () => {
    expect(MAX_REPAIRS).toBe(3);
  });

  it("stops after exactly MAX_REPAIRS repairs when validation never passes", async () => {
    let calls = 0;
    const report = await runConversion({
      url: "aaa-strategy-one",
      catalog: CATALOG,
      invoke: async () => { calls++; return okCode; },
      validate: () => ({ ok: false, errors: ["persistent error"] }),
      writeAttempt: memWriter(),
    });
    // 1 initial generation + MAX_REPAIRS repairs.
    expect(calls).toBe(MAX_REPAIRS + 1);
    expect(report.attempts).toBe(MAX_REPAIRS + 1);
    expect(report.repairAttempts).toBe(MAX_REPAIRS);
    expect(report.validationStatus).toBe("failed");
    expect(report.errors).toEqual(["persistent error"]);
  });

  it("respects a custom lower repair budget", async () => {
    let calls = 0;
    const report = await runConversion({
      url: "aaa-strategy-one",
      catalog: CATALOG,
      invoke: async () => { calls++; return okCode; },
      validate: () => ({ ok: false, errors: ["e"] }),
      writeAttempt: memWriter(),
      maxRepairs: 1,
    });
    expect(calls).toBe(2);
    expect(report.repairAttempts).toBe(1);
    expect(report.validationStatus).toBe("failed");
  });

  it("reports unsupported features parsed from the model output", async () => {
    const report = await runConversion({
      url: "aaa-strategy-one",
      catalog: CATALOG,
      invoke: async () => "```ts\n// @unsupported: trailing stop - no price field\nexport const e = () => [];\n```",
      validate: () => ({ ok: true, errors: [] }),
      writeAttempt: memWriter(),
    });
    expect(report.unsupportedFeatures).toEqual(["trailing stop - no price field"]);
  });

  it("accumulates unsupported markers across attempts and keeps ones a later repair omits", async () => {
    const outputs = [
      "```ts\n// @unsupported: ATR trailing stop - no price field\nexport const e = () => [];\n```",
      "```ts\n// @unsupported: ATR trailing stop - no price field\n// @unsupported: pyramiding - no side field\nexport const e = () => [];\n```",
      "```ts\nexport const e = () => [];\n```", // repair 2 drops the markers
      "```ts\nexport const e = () => [];\n```", // repair 3 drops the markers
    ];
    let i = 0;
    const report = await runConversion({
      url: "aaa-strategy-one",
      catalog: CATALOG,
      invoke: async () => outputs[i++],
      validate: () => ({ ok: false, errors: ["still failing"] }),
      writeAttempt: memWriter(),
    });
    expect(report.repairAttempts).toBe(3);
    expect(report.validationStatus).toBe("failed");
    // Deduplicated, first-seen order, and NOT lost despite the later repairs omitting them.
    expect(report.unsupportedFeatures).toEqual([
      "ATR trailing stop - no price field",
      "pyramiding - no side field",
    ]);
  });

  it("propagates selection/convertibility errors", async () => {
    await expect(
      runConversion({
        url: "ccc-indicator",
        catalog: CATALOG,
        invoke: async () => okCode,
        validate: () => ({ ok: true, errors: [] }),
        writeAttempt: memWriter(),
      }),
    ).rejects.toThrow(/not a strategy/);
  });
});

describe("planDryRun (no credentials, no network)", () => {
  it("plans a dry run for the real EMA catalog entry", () => {
    const ema = loadCatalog().find((e) => e.url.includes("fURZdvM1")) as CatalogEntry;
    const plan = planDryRun(ema.url);
    expect(plan.version).toBe(6);
    expect(plan.sourceChars).toBeGreaterThan(0);
    expect(plan.systemPromptChars).toBeGreaterThan(0);
    expect(plan.userPromptChars).toBeGreaterThan(plan.sourceChars);
    expect(plan.unsupportedRulesIncluded).toBe(true);
    expect(plan.stagingTarget).toContain(".pine-convert");
  });
});

// Real `tsc --noEmit` validation. Deterministic and offline (no model, no
// network); proves the static gate accepts clean code and rejects type errors,
// and that pre-existing src/** errors are filtered out.
describe("tscValidator (real static validation)", () => {
  const validate = tscValidator();

  it("passes a clean generated-style strategy file", () => {
    const good = path.join(TEST_STAGING, "good", "clean.ts");
    writeStagedFile(
      good,
      [
        'import type { TradeSignal } from "@/trading-agents/types";',
        'import type { HistoricalQuote } from "@/stocks/quote-cache-service";',
        'export type ProbeBar = Pick<HistoricalQuote, "date" | "close">;',
        "export function evaluateProbe(bars: readonly ProbeBar[]): TradeSignal[] {",
        '  return bars.map((b) => ({ action: "HOLD" as const, confidence: 0, reasoning: "x", timestamp: new Date(b.date) }));',
        "}",
        "",
      ].join("\n"),
    );
    const result: ValidationResult = validate(good);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails a file with a type error, attributing it to the staged file", () => {
    const bad = path.join(TEST_STAGING, "bad", "broken.ts");
    writeStagedFile(
      bad,
      [
        'import type { TradeSignal } from "@/trading-agents/types";',
        'export const x: TradeSignal["action"] = "NOPE";',
        "",
      ].join("\n"),
    );
    const result = validate(bad);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("broken.ts"))).toBe(true);
  });

  it("removes the ephemeral tsconfig after a real successful validation", () => {
    const good = path.join(TEST_STAGING, "cleanup-ok", "clean.ts");
    writeStagedFile(
      good,
      [
        'import type { TradeSignal } from "@/trading-agents/types";',
        "export const a: TradeSignal[\"action\"] = \"HOLD\";",
        "",
      ].join("\n"),
    );
    const tsconfigPath = good.replace(/\.ts$/, "") + ".tsconfig.json";
    const result = validate(good);
    expect(result.ok).toBe(true);
    expect(fs.existsSync(tsconfigPath)).toBe(false); // cleaned up
    expect(fs.existsSync(good)).toBe(true); // attempt file preserved
  });
});

describe("interpretTscResult exit handling", () => {
  const staged = "/stage/foo.attempt-0.ts";

  it("passes on a clean (status 0) run with no diagnostics", () => {
    expect(interpretTscResult({ status: 0, output: "" }, staged).ok).toBe(true);
  });

  it("passes on a nonzero exit caused only by pre-existing errors in other files", () => {
    const output = [
      "src/alpaca/alpaca-mcp-client.ts(111,23): error TS18046: 'error' is of type 'unknown'.",
      "src/stocks/unified-quote-service.ts(109,35): error TS2740: missing props.",
    ].join("\n");
    expect(interpretTscResult({ status: 2, output }, staged).ok).toBe(true);
  });

  it("fails when a diagnostic is attributable to the generated file", () => {
    const output = [
      "/stage/foo.attempt-0.ts(2,14): error TS2322: not assignable.",
      "src/a.ts(1,2): error TS18046: unrelated.",
    ].join("\n");
    const r = interpretTscResult({ status: 2, output }, staged);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("foo.attempt-0.ts(2,14)"))).toBe(true);
  });

  it("does NOT pass when tsc exits nonzero with no diagnostics at all", () => {
    const r = interpretTscResult({ status: 1, output: "\n   \n" }, staged);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/no diagnostics/);
  });

  it("fails on a configuration/compiler-level error even if not attributable", () => {
    const output = "error TS5083: Cannot read file 'x.tsconfig.json'.";
    const r = interpretTscResult({ status: 1, output }, staged);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/configuration\/compiler-level/);
  });

  it("fails when the process was killed or timed out (status null)", () => {
    const r = interpretTscResult({ status: null, output: "" }, staged);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/timed out|killed/);
  });

  it("fails when the process could not be spawned", () => {
    const r = interpretTscResult({ status: null, output: "", spawnError: "ENOENT" }, staged);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/Failed to run tsc/);
  });
});

describe("tscValidator cleanup on failure (injected runner)", () => {
  it("removes the tsconfig and keeps the .ts attempt when the compiler fails to run", () => {
    const staged = path.join(TEST_STAGING, "cleanup-spawnfail", "x.ts");
    writeStagedFile(staged, "export const y = 1;\n");
    const tsconfigPath = staged.replace(/\.ts$/, "") + ".tsconfig.json";
    let sawConfig = false;
    const spawnFail = (cfg: string) => {
      sawConfig = fs.existsSync(cfg); // tsconfig exists while the runner is invoked
      return { status: null as number | null, output: "", spawnError: "ENOENT: tsc not found" };
    };
    const result = tscValidator(spawnFail)(staged);
    expect(sawConfig).toBe(true);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(tsconfigPath)).toBe(false); // removed in finally
    expect(fs.existsSync(staged)).toBe(true); // attempt file never deleted
  });

  it("removes the tsconfig when the compiler exits nonzero with no diagnostics", () => {
    const staged = path.join(TEST_STAGING, "cleanup-nodiag", "x.ts");
    writeStagedFile(staged, "export const y = 1;\n");
    const tsconfigPath = staged.replace(/\.ts$/, "") + ".tsconfig.json";
    const result = tscValidator(() => ({ status: 1, output: "" }))(staged);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(tsconfigPath)).toBe(false);
    expect(fs.existsSync(staged)).toBe(true);
  });
});
