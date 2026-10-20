import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type CatalogEntry, loadCatalog } from "../scripts/pine-convert";
import {
  HIGH_MIN_SCORE,
  LOW_MAX_SCORE,
  MAX_SCORE,
  PINE_FEATURES,
  analyzeEntry,
  analyzeSource,
  buildReport,
  classifyComplexity,
  countMatches,
  detectVersionInfo,
  findDuplicateUrls,
  isStrategyScript,
  parseOrder,
  scoreFeatures,
  sortStrategies,
  stripLineComments,
  writeReportFile,
  type StrategyReport,
} from "../scripts/pine-benchmark";

// --- Synthetic Pine snippets (deterministic, no catalog dependency) --------

/** A heavy strategy touching nearly every tracked feature. */
const HEAVY = [
  "//@version=5",
  "strategy('Heavy', overlay=true, pyramiding=2, default_qty_type=strategy.percent_of_equity, default_qty_value=10)",
  "atr = ta.atr(14)",
  "htf = request.security(syminfo.tickerid, '60', close)",
  "plot(close)",
  "alert('hi')",
  "strategy.entry('L', strategy.long, qty=5, stop=close - atr)",
  "strategy.exit('X', from_entry='L', limit=close + atr, stop=close - atr, trail_points=atr * 0.1)",
].join("\n");

/** A trivial, fully-representable strategy. */
const SIMPLE = [
  "//@version=6",
  "strategy('Simple')",
  "if ta.crossover(close, open)",
  "    strategy.entry('L', strategy.long)",
].join("\n");

/** A bare indicator (not a strategy). */
const INDICATOR = ["//@version=5", "indicator('Ind')", "plot(close)"].join("\n");

describe("stripLineComments", () => {
  it("removes // comments but keeps code", () => {
    expect(stripLineComments("a = 1 // set a\nb = 2")).toBe("a = 1 \nb = 2");
  });

  it("does not strip // inside a string literal", () => {
    expect(stripLineComments("x = 'http://y' // real comment")).toBe("x = 'http://y' ");
    expect(stripLineComments('s = "a // b"')).toBe('s = "a // b"');
  });

  it("prevents commented-out code from being detected as a feature", () => {
    const src = "// strategy.exit('X', trail_points=1)\nstrategy.entry('L', strategy.long)";
    const a = analyzeSource(src);
    expect(a.featureCounts.strategyExit).toBe(0);
    expect(a.featureCounts.trailingStop).toBe(0);
  });
});

describe("countMatches", () => {
  it("counts every occurrence, case-insensitively, and is lastIndex-safe", () => {
    const re = /\bstop\s*=/gi;
    const text = "stop=1 STOP = 2 stop =3";
    expect(countMatches(re, text)).toBe(3);
    // Re-running must yield the same count (lastIndex reset).
    expect(countMatches(re, text)).toBe(3);
  });
});

describe("detectVersionInfo", () => {
  it("detects supported versions 5 and 6", () => {
    expect(detectVersionInfo("//@version=5")).toEqual({ version: 5, raw: 5, status: "supported" });
    expect(detectVersionInfo("// @version = 6 ")).toEqual({
      version: 6,
      raw: 6,
      status: "supported",
    });
  });

  it("flags unsupported versions without throwing", () => {
    expect(detectVersionInfo("//@version=4")).toEqual({
      version: null,
      raw: 4,
      status: "unsupported",
    });
  });

  it("flags a missing version tag", () => {
    expect(detectVersionInfo("strategy('x')")).toEqual({
      version: null,
      raw: null,
      status: "missing",
    });
  });
});

describe("isStrategyScript", () => {
  it("is true for a strategy() call and false for an indicator", () => {
    expect(isStrategyScript(stripLineComments(SIMPLE))).toBe(true);
    expect(isStrategyScript(stripLineComments(INDICATOR))).toBe(false);
  });

  it("does not count a commented-out strategy() call", () => {
    expect(isStrategyScript(stripLineComments("// strategy('x')\nplot(close)"))).toBe(false);
  });
});

describe("feature detection", () => {
  it("detects the full feature set in a heavy strategy", () => {
    const a = analyzeSource(HEAVY);
    for (const f of PINE_FEATURES) {
      expect(a.featureCounts[f.id]).toBeGreaterThan(0);
    }
    expect(a.detectedFeatures).toEqual(PINE_FEATURES.map((f) => f.id));
  });

  it("lists only non-representable detected features in unrepresentableFeatures", () => {
    const a = analyzeSource(HEAVY);
    const expected = PINE_FEATURES.filter((f) => !f.representable).map((f) => f.id);
    expect(a.unrepresentableFeatures.sort()).toEqual(expected.sort());
    expect(a.unrepresentableFeatures).not.toContain("plotting");
    expect(a.unrepresentableFeatures).not.toContain("alerts");
    expect(a.unrepresentableFeatures).not.toContain("atr");
  });

  it("detects nothing risky in a simple strategy", () => {
    const a = analyzeSource(SIMPLE);
    expect(a.detectedFeatures).toEqual([]);
    expect(a.score).toBe(0);
  });
});

describe("scoring", () => {
  it("MAX_SCORE equals the sum of all feature weights", () => {
    expect(MAX_SCORE).toBe(PINE_FEATURES.reduce((s, f) => s + f.weight, 0));
  });

  it("is presence-weighted: repeated occurrences do not raise the score", () => {
    const once = { strategyExit: 1 } as Record<string, number>;
    const many = { strategyExit: 9 } as Record<string, number>;
    const w = PINE_FEATURES.find((f) => f.id === "strategyExit")!.weight;
    expect(scoreFeatures(once)).toBe(w);
    expect(scoreFeatures(many)).toBe(w); // count does not scale the score
  });

  it("sums the weights of present features", () => {
    const a = analyzeSource(HEAVY);
    expect(a.score).toBe(MAX_SCORE);
  });
});

describe("classifyComplexity thresholds", () => {
  it("maps boundary scores to the documented tiers", () => {
    expect(classifyComplexity(0)).toBe("low");
    expect(classifyComplexity(LOW_MAX_SCORE)).toBe("low");
    expect(classifyComplexity(LOW_MAX_SCORE + 1)).toBe("medium");
    expect(classifyComplexity(HIGH_MIN_SCORE - 1)).toBe("medium");
    expect(classifyComplexity(HIGH_MIN_SCORE)).toBe("high");
    expect(classifyComplexity(MAX_SCORE)).toBe("high");
  });
});

describe("analyzeEntry warnings", () => {
  it("warns and marks non-analyzable on empty source", () => {
    const r = analyzeEntry({ url: "empty", source: "   " });
    expect(r.analyzable).toBe(false);
    expect(r.score).toBe(0);
    expect(r.warnings.some((w) => /missing source/i.test(w))).toBe(true);
  });

  it("warns on an unsupported version", () => {
    const r = analyzeEntry({ url: "v4", source: "//@version=4\nstrategy('x')" });
    expect(r.versionStatus).toBe("unsupported");
    expect(r.warnings.some((w) => /Unsupported Pine version 4/.test(w))).toBe(true);
  });

  it("warns when the script is not a strategy", () => {
    const r = analyzeEntry({ url: "ind", source: INDICATOR });
    expect(r.isStrategy).toBe(false);
    expect(r.warnings.some((w) => /not convertible|indicator/i.test(w))).toBe(true);
  });

  it("warns about unrepresentable features on a heavy strategy", () => {
    const r = analyzeEntry({ url: "heavy", name: "Heavy", source: HEAVY });
    expect(r.complexity).toBe("high");
    expect(r.warnings.some((w) => /cannot represent faithfully/i.test(w))).toBe(true);
  });

  it("falls back to the url when name is absent", () => {
    expect(analyzeEntry({ url: "no-name", source: SIMPLE }).name).toBe("no-name");
  });
});

describe("findDuplicateUrls", () => {
  it("returns a sorted list of urls that appear more than once", () => {
    const catalog: CatalogEntry[] = [
      { url: "b", source: SIMPLE },
      { url: "a", source: SIMPLE },
      { url: "b", source: SIMPLE },
      { url: "a", source: SIMPLE },
      { url: "c", source: SIMPLE },
    ];
    expect(findDuplicateUrls(catalog)).toEqual(["a", "b"]);
  });

  it("returns [] when all urls are unique", () => {
    expect(findDuplicateUrls([{ url: "a", source: SIMPLE }])).toEqual([]);
  });
});

describe("sortStrategies (deterministic)", () => {
  const mk = (url: string, score: number, analyzable = true): StrategyReport =>
    ({
      url,
      name: url,
      version: 5,
      rawVersion: 5,
      versionStatus: "supported",
      isStrategy: true,
      analyzable,
      complexity: "low",
      warnings: [],
      featureCounts: {},
      detectedFeatures: [],
      unrepresentableFeatures: [],
      score,
    }) as StrategyReport;

  it("orders by score descending by default, ties broken by url ascending", () => {
    const sorted = sortStrategies([mk("z", 5), mk("a", 5), mk("m", 9)], "highest");
    expect(sorted.map((s) => s.url)).toEqual(["m", "a", "z"]);
  });

  it("orders by score ascending for 'lowest', ties still by url ascending", () => {
    const sorted = sortStrategies([mk("z", 5), mk("a", 5), mk("m", 9)], "lowest");
    expect(sorted.map((s) => s.url)).toEqual(["a", "z", "m"]);
  });

  it("always sorts non-analyzable entries last, regardless of order", () => {
    const high = sortStrategies([mk("x", 0, false), mk("y", 1, true)], "highest");
    expect(high.map((s) => s.url)).toEqual(["y", "x"]);
    const low = sortStrategies([mk("x", 0, false), mk("y", 1, true)], "lowest");
    expect(low.map((s) => s.url)).toEqual(["y", "x"]);
  });

  it("does not mutate its input", () => {
    const input = [mk("z", 5), mk("a", 9)];
    const before = input.map((s) => s.url);
    sortStrategies(input, "highest");
    expect(input.map((s) => s.url)).toEqual(before);
  });
});

describe("buildReport", () => {
  const catalog: CatalogEntry[] = [
    { url: "heavy", name: "Heavy", source: HEAVY },
    { url: "simple", name: "Simple", source: SIMPLE },
    { url: "ind", name: "Indicator", source: INDICATOR },
    { url: "empty", name: "Empty", source: "   " },
  ];

  it("summarizes totals, versions, prevalence, and sorts by complexity", () => {
    const report = buildReport(catalog, { catalogPath: "mem://catalog.json" });
    expect(report.totalEntries).toBe(4);
    expect(report.analyzableEntries).toBe(3); // empty excluded
    // Version buckets cover every entry, including the empty one (no tag -> missing).
    expect(report.versionCounts).toEqual({ "5": 2, "6": 1, unsupported: 0, missing: 1 });
    expect(report.featurePrevalence.plotting).toBe(2); // heavy + indicator
    expect(report.featurePrevalence.trailingStop).toBe(1); // heavy only
    // Most complex first; empty (non-analyzable) last. The indicator scores 1
    // (a plot) and so outranks the featureless simple strategy (score 0).
    expect(report.strategies.map((s) => s.url)).toEqual(["heavy", "ind", "simple", "empty"]);
    expect(report.scoring.maxScore).toBe(MAX_SCORE);
    expect(report.scoring.thresholds).toEqual({
      lowMaxScore: LOW_MAX_SCORE,
      highMinScore: HIGH_MIN_SCORE,
    });
  });

  it("warns on an empty catalog", () => {
    const report = buildReport([]);
    expect(report.totalEntries).toBe(0);
    expect(report.warnings.some((w) => /empty/i.test(w))).toBe(true);
  });

  it("warns on duplicate urls", () => {
    const dup: CatalogEntry[] = [
      { url: "same", source: SIMPLE },
      { url: "same", source: HEAVY },
    ];
    const report = buildReport(dup);
    expect(report.warnings.some((w) => /duplicate url/i.test(w))).toBe(true);
  });

  it("applies the limit option after sorting", () => {
    const report = buildReport(catalog, { limit: 1 });
    expect(report.strategies).toHaveLength(1);
    expect(report.strategies[0].url).toBe("heavy");
  });

  it("is deterministic: identical input yields identical output", () => {
    expect(JSON.stringify(buildReport(catalog))).toBe(JSON.stringify(buildReport(catalog)));
  });
});

describe("parseOrder", () => {
  it("defaults to highest and accepts lowest", () => {
    expect(parseOrder(undefined)).toBe("highest");
    expect(parseOrder("highest")).toBe("highest");
    expect(parseOrder("nonsense")).toBe("highest");
    expect(parseOrder("lowest")).toBe("lowest");
  });
});

describe("writeReportFile safety (never overwrites without --force)", () => {
  let dir: string;
  const made: string[] = [];
  const tmp = (name: string) => {
    if (!dir) dir = fs.mkdtempSync(path.join(os.tmpdir(), "pine-bench-"));
    const p = path.join(dir, name);
    made.push(p);
    return p;
  };

  afterEach(() => {
    for (const p of made.splice(0)) fs.rmSync(p, { force: true });
    if (dir) {
      try {
        fs.rmdirSync(dir);
      } catch {
        /* non-empty or already gone */
      }
      dir = "";
    }
  });

  const report = buildReport([{ url: "a", source: SIMPLE }]);

  it("writes a new file", () => {
    const out = tmp("report.json");
    writeReportFile(out, report);
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(parsed.totalEntries).toBe(1);
  });

  it("throws rather than overwrite an existing file", () => {
    const out = tmp("report.json");
    fs.writeFileSync(out, "ORIGINAL");
    expect(() => writeReportFile(out, report)).toThrow();
    expect(fs.readFileSync(out, "utf8")).toBe("ORIGINAL"); // untouched
  });

  it("overwrites only when force is set", () => {
    const out = tmp("report.json");
    fs.writeFileSync(out, "ORIGINAL");
    writeReportFile(out, report, { force: true });
    expect(fs.readFileSync(out, "utf8")).not.toBe("ORIGINAL");
  });
});

// A single representative check against the real committed catalog, proving the
// benchmark runs offline over the shipped schema.
describe("real catalog (offline, deterministic)", () => {
  it("benchmarks the committed catalog and ranks the heaviest strategy as high complexity", () => {
    const report = buildReport(loadCatalog(), { order: "highest" });
    expect(report.totalEntries).toBeGreaterThan(0);
    expect(report.analyzableEntries).toBeGreaterThan(0);
    expect(report.strategies[0].complexity).toBe("high");
    // Version buckets cover the whole catalog.
    const versioned = Object.values(report.versionCounts).reduce((a, b) => a + b, 0);
    expect(versioned).toBe(report.totalEntries);
  });
});
