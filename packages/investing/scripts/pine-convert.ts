/**
 * Pine Script → TypeScript conversion pipeline (proof of concept).
 *
 * Selects a strategy from the committed catalog
 * (`src/algo-stategies/algo-strategies.json`), asks a configured AI model to
 * port it to the project's deterministic, signal-only strategy convention (see
 * `src/stocks/strategies/ema-crossover.ts` and `bb-rsi-breakout.ts`), validates
 * the generated TypeScript statically, and runs a bounded repair loop.
 *
 * SAFETY — this pipeline is intentionally narrow:
 *   - Reads the catalog from disk; NEVER runs the TradingView scraper or any
 *     other network fetch except the single AI model call, which only happens
 *     with an explicit `--run` flag AND a configured key.
 *   - Writes generated code ONLY into the ignored staging dir (`.pine-convert/`),
 *     never into `src/`, and never overwrites an existing file (open flag "wx").
 *   - Validates statically with `tsc --noEmit` BEFORE the code is ever executed.
 *     This pipeline never imports or runs the generated code.
 *   - Contains no brokerage, order, or live-trading calls.
 *   - Never logs API keys.
 *
 * Usage:
 *   bun scripts/pine-convert.ts --url=<catalog-url> [--dry-run]      # default: dry-run
 *   bun scripts/pine-convert.ts --url=<catalog-url> --run [--model=gpt-4.1]
 *
 * Dry-run prints the selected entry and planned prompt metadata without needing
 * any model credentials.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { callOpenAIResponses } from "../src/prediction-markets/ai/callOpenAI";
// Type-only import: erased at runtime, so it introduces NO module edge and no
// load-order concern. The real checker is injected (CLI wires it via dynamic
// import of the standalone pine-conformance / pine-features leaf modules).
import type {
  ConformanceChecker,
  ConformanceContext,
  ConformanceFinding,
  ConformanceResult,
} from "./pine-conformance";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
/** Package root (`packages/investing`). */
export const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, "..");
/** The committed catalog of scraped TradingView strategies. */
export const DEFAULT_CATALOG_PATH = path.join(
  PACKAGE_ROOT,
  "src/algo-stategies/algo-strategies.json",
);
/** Ignored staging directory for generated, unreviewed output. Never `src/`. */
export const STAGING_DIR = path.join(PACKAGE_ROOT, ".pine-convert");
/** Maximum repair iterations after the initial generation. */
export const MAX_REPAIRS = 3;
/** Hard timeout for a single `tsc` validation run. */
export const TSC_TIMEOUT_MS = 180_000;
/** Pine versions this pipeline understands. */
export const SUPPORTED_PINE_VERSIONS = [5, 6] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  url: string;
  name?: string;
  description?: string;
  author?: string;
  script_type?: string;
  source?: string;
  [key: string]: unknown;
}

export type PineVersion = (typeof SUPPORTED_PINE_VERSIONS)[number];

export interface ConversionPrompt {
  system: string;
  user: string;
}

/** Produces model output text from a prompt. Injectable for tests / dry-run. */
export type ModelInvoker = (prompt: ConversionPrompt) => Promise<string>;

export interface ValidationResult {
  ok: boolean;
  /** Diagnostics attributable to the generated file only (pre-existing
   * `src/**` errors are filtered out). */
  errors: string[];
}

/** Validates a staged TypeScript file. Injectable for tests. */
export type Validator = (stagedFilePath: string) => ValidationResult;

export interface ConversionReport {
  url: string;
  name: string;
  version: PineVersion;
  /** Total model generations (1 initial + repairs). */
  attempts: number;
  /** Repair iterations used (0 when the first attempt validated). */
  repairAttempts: number;
  validationStatus: "passed" | "failed";
  errors: string[];
  unsupportedFeatures: string[];
  stagedFile?: string;
  /**
   * Static conformance gate result. It runs ONLY after a successful `tsc`
   * validation, so `status` is `"skipped"` whenever the final attempt never
   * type-checked. `"failed"` means at least one `error`-severity finding
   * remained after the repair budget; `"passed"` means no error-severity
   * findings (warnings may still be present in `findings`). These are static
   * checks and never prove semantic equivalence to the Pine source.
   */
  conformance: {
    status: "passed" | "failed" | "skipped";
    findings: ConformanceFinding[];
  };
}

export interface DryRunPlan {
  url: string;
  name: string;
  version: PineVersion;
  scriptType: string;
  sourceChars: number;
  systemPromptChars: number;
  userPromptChars: number;
  systemPromptPreview: string;
  unsupportedRulesIncluded: boolean;
  stagingTarget: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function loadCatalog(catalogPath: string = DEFAULT_CATALOG_PATH): CatalogEntry[] {
  if (!fs.existsSync(catalogPath)) {
    throw new Error(`Catalog not found at ${catalogPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Catalog must be a JSON array of strategy entries");
  }
  return parsed as CatalogEntry[];
}

/** Select a catalog entry by its unique `url` (never by name). */
export function selectStrategyByUrl(catalog: CatalogEntry[], url: string): CatalogEntry {
  if (!url || !url.trim()) {
    throw new Error("A non-empty --url is required");
  }
  const matches = catalog.filter((e) => e.url === url);
  if (matches.length === 0) {
    throw new Error(`No catalog entry found for url "${url}"`);
  }
  if (matches.length > 1) {
    // url is documented as unique; guard anyway so a bad catalog fails loudly.
    throw new Error(`Catalog has ${matches.length} entries for url "${url}" (expected unique)`);
  }
  return matches[0];
}

/** Detect the Pine version from `//@version=N`. Throws on missing/unsupported. */
export function detectPineVersion(source: string): PineVersion {
  const match = (source ?? "").match(/\/\/\s*@version\s*=\s*(\d+)/);
  if (!match) {
    throw new Error("Could not detect a Pine Script version (no //@version= tag)");
  }
  const version = Number(match[1]);
  if (!SUPPORTED_PINE_VERSIONS.includes(version as PineVersion)) {
    throw new Error(
      `Unsupported Pine Script version ${version}; this pipeline supports ${SUPPORTED_PINE_VERSIONS.join(", ")}`,
    );
  }
  return version as PineVersion;
}

/**
 * Reject entries that cannot be converted: empty source, or a script that is
 * not a `strategy(...)` (e.g. a bare `indicator`/`study`). Returns the version.
 */
export function assertConvertible(entry: CatalogEntry): PineVersion {
  const source = (entry.source ?? "").trim();
  if (!source) {
    throw new Error(`Catalog entry "${entry.url}" has empty source`);
  }
  if (!/\bstrategy\s*\(/.test(source)) {
    throw new Error(
      `Catalog entry "${entry.url}" is not a strategy (no strategy() call); only strategies are supported`,
    );
  }
  return detectPineVersion(source);
}

/** Filesystem-safe slug derived from a catalog url. */
export function slugFromUrl(url: string): string {
  const slug = url
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "strategy";
}

/** Strip a Markdown code fence if the model wrapped its output in one. */
export function extractTypeScript(modelText: string): string {
  const fence = modelText.match(/```(?:ts|typescript)?\s*\n([\s\S]*?)\n```/i);
  const code = fence ? fence[1] : modelText;
  return code.trim() + "\n";
}

/**
 * Extract the unsupported-feature report the model is required to emit as
 * `// @unsupported: <feature> - <reason>` comment lines. Returns [] when the
 * model reported full fidelity.
 */
export function parseUnsupportedFeatures(modelText: string): string[] {
  const out: string[] = [];
  const re = /\/\/\s*@unsupported:\s*(.+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(modelText)) !== null) {
    const value = m[1].trim();
    if (value && !/^none\b/i.test(value)) out.push(value);
  }
  return out;
}

/** The fidelity rules the model must obey (shared by the prompt builders). */
export const UNSUPPORTED_FEATURE_RULES = [
  "The target `TradeSignal` type is { action: 'BUY'|'SELL'|'HOLD'; confidence: number; reasoning: string; timestamp: Date }.",
  "It CANNOT carry a limit/stop price, a position size/quantity, or an explicit long/short open-close side.",
  "Therefore you MUST NOT invent position sizing, stop-loss prices, trailing stops, pyramiding, multi-timeframe (request.security), alerts, or plotting.",
  "If the source Pine strategy uses any feature that cannot be represented faithfully by `TradeSignal`, DO NOT silently approximate it.",
  "Instead, declare each such feature at the top of the file as a comment line: `// @unsupported: <feature> - <why it cannot be represented>`.",
  "Represent a take-profit/exit as a BUY/SELL signal whose `reasoning` states the level, exactly as the existing ports do.",
  "Keep the function pure, deterministic, and offline: no network, no Date.now(), no randomness, no order placement.",
].join("\n");

/** The project convention the generated strategy must follow. */
export const STRATEGY_CONTRACT = [
  "Write ONE TypeScript module exporting a pure function `evaluate<Name>(bars, config?): TradeSignal[]`.",
  "Import types ONLY via the project path alias: `import type { TradeSignal } from \"@/trading-agents/types\";` and, if you need OHLCV fields, `import type { HistoricalQuote } from \"@/stocks/quote-cache-service\";`.",
  "Export: a `<Name>Config` interface, a `DEFAULT_<NAME>_CONFIG` constant, a `<Name>Bar` type (a `Pick<HistoricalQuote, ...>` of exactly the fields you read), a `normalize<Name>Config()` validator, and the `evaluate<Name>` function.",
  "Return exactly one signal per input bar, in order; confidence 1 for an actionable BUY/SELL and 0 for HOLD; timestamp from the bar's own `date`, never the wall clock.",
  "Inline any indicator maths (SMA, EMA, RSI, stdev, ...) as small dependency-free helpers; do not add new npm dependencies.",
  "Validate config and reject malformed bars loudly (throw with the offending index), like the existing strategies.",
  "Force HOLD during a warm-up window until enough bars exist for the longest lookback.",
].join("\n");

/** The test expectations the generated code should be written to satisfy. */
export const TEST_EXPECTATIONS = [
  "The code must be strict-TypeScript clean (the project uses `strict: true`).",
  "It must be deterministic: identical input yields identical output.",
  "It must handle an empty bar array (return []) and throw on non-finite prices or invalid dates.",
].join("\n");

export function buildConversionPrompt(entry: CatalogEntry, version: PineVersion): ConversionPrompt {
  const system = [
    "You are a meticulous engineer porting TradingView Pine Script STRATEGIES to TypeScript for the `investing` package.",
    "You must preserve the source's trading logic exactly and never loosen or invent risk behavior.",
    "",
    "## Target convention",
    STRATEGY_CONTRACT,
    "",
    "## Fidelity rules",
    UNSUPPORTED_FEATURE_RULES,
    "",
    "## Quality bar",
    TEST_EXPECTATIONS,
    "",
    "Respond with ONLY the TypeScript module in a single ```ts code block. No prose outside the code block.",
  ].join("\n");

  const user = [
    `Port this Pine Script v${version} strategy to TypeScript.`,
    `Catalog url: ${entry.url}`,
    `Name: ${entry.name ?? "(unnamed)"}`,
    "",
    "```pine",
    entry.source ?? "",
    "```",
  ].join("\n");

  return { system, user };
}

export function buildRepairPrompt(
  entry: CatalogEntry,
  version: PineVersion,
  previousCode: string,
  errors: string[],
  conformanceErrors: string[] = [],
): ConversionPrompt {
  const base = buildConversionPrompt(entry, version);
  const lines: string[] = [
    "Your previous TypeScript port failed static validation. Fix ONLY what the errors require; keep the trading logic faithful.",
    "",
  ];
  if (errors.length > 0) {
    lines.push("## Validation errors", errors.join("\n"), "");
  }
  if (conformanceErrors.length > 0) {
    lines.push(
      "## Conformance findings (project signal-only convention — must fix)",
      conformanceErrors.join("\n"),
      "",
    );
  }
  if (errors.length === 0 && conformanceErrors.length === 0) {
    lines.push("## Validation errors", "(no error text captured)", "");
  }
  lines.push(
    "## Your previous output",
    "```ts",
    previousCode.trim(),
    "```",
    "",
    "Return the corrected, complete module in a single ```ts code block.",
  );
  return { system: base.system, user: lines.join("\n") };
}

/** Build the ephemeral tsconfig used to type-check one staged file. */
export function buildValidationTsconfig(stagedFilePath: string): Record<string, unknown> {
  return {
    extends: path.join(PACKAGE_ROOT, "tsconfig.json"),
    compilerOptions: {
      noEmit: true,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      // Staged file lives under the package root (not src/), so widen rootDir.
      rootDir: PACKAGE_ROOT,
    },
    include: [stagedFilePath],
  };
}

/**
 * Keep only tsc diagnostic lines that refer to the staged file, so pre-existing
 * errors elsewhere in `src/**` (which the import graph drags in) never affect
 * this file's pass/fail.
 */
export function filterTscDiagnostics(tscOutput: string, stagedFilePath: string): string[] {
  const baseName = path.basename(stagedFilePath);
  return tscOutput
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => l.replace(/\\/g, "/").includes(baseName + "("));
}

// ---------------------------------------------------------------------------
// Side-effecting pieces (kept thin; orchestration is injected in tests)
// ---------------------------------------------------------------------------

/** Write a file, failing if it already exists (never overwrite). */
export function writeStagedFile(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { flag: "wx" }); // "wx" → throw if exists
  return filePath;
}

/** Locate the `tsc` executable bundled in the monorepo's node_modules. */
function resolveTscBin(): string {
  const binDir = path.join(PACKAGE_ROOT, "..", "..", "node_modules", ".bin");
  const candidates =
    process.platform === "win32"
      ? ["tsc.exe", "tsc.cmd", "tsc"]
      : ["tsc"];
  for (const name of candidates) {
    const full = path.join(binDir, name);
    if (fs.existsSync(full)) return full;
  }
  return "tsc"; // fall back to PATH
}

/** Raw result of running the compiler, independent of how it was spawned. */
export interface TscRunResult {
  /** Process exit code; `null` when the process was killed (e.g. timed out). */
  status: number | null;
  /** Combined stdout + stderr. */
  output: string;
  /** Set when the process could not be spawned at all. */
  spawnError?: string;
}

/** Runs `tsc -p <tsconfig>`. Injectable so tests can simulate failures. */
export type TscRunner = (tsconfigPath: string) => TscRunResult;

/**
 * Interpret a compiler run into a pass/fail verdict for the generated file.
 *
 * A generated file passes ONLY when the compiler actually type-checked it and
 * produced no diagnostics attributable to it. Crucially, an empty set of
 * attributable diagnostics is NOT sufficient: in this repo `tsc` exits nonzero
 * because of pre-existing errors in `src/**`, so we must tell that expected,
 * benign nonzero exit apart from a compiler-level failure (bad config, crash,
 * timeout, or no output) that never validated the file at all.
 */
export function interpretTscResult(run: TscRunResult, stagedFilePath: string): ValidationResult {
  if (run.spawnError) {
    return { ok: false, errors: [`Failed to run tsc: ${run.spawnError}`] };
  }

  // Errors in the generated file itself always fail.
  const attributable = filterTscDiagnostics(run.output, stagedFilePath);
  if (attributable.length > 0) {
    return { ok: false, errors: attributable };
  }

  // Killed / timed out → could not validate.
  if (run.status === null) {
    return {
      ok: false,
      errors: ["tsc did not complete (timed out or was killed); cannot validate the generated file"],
    };
  }

  // Clean exit with nothing attributable → genuinely clean.
  if (run.status === 0) {
    return { ok: true, errors: [] };
  }

  // Nonzero exit, nothing attributable. Decide whether this is the expected
  // "pre-existing errors elsewhere" case or a real compiler-level failure.
  const configErrors = run.output.match(/^\s*error TS\d+:/gm) ?? []; // no file(line,col) prefix
  const fileDiagnostics = run.output.match(/\(\d+,\d+\):\s*error TS\d+/g) ?? [];

  if (configErrors.length > 0) {
    return {
      ok: false,
      errors: [
        "tsc reported a configuration/compiler-level error; cannot validate the generated file",
        ...configErrors.map((e) => e.trim()),
      ],
    };
  }
  if (fileDiagnostics.length > 0) {
    // Nonzero solely due to pre-existing errors in other project files.
    return { ok: true, errors: [] };
  }
  // Nonzero with no diagnostics at all → the compiler failed for an unknown
  // reason and never validated the file. Do not pass.
  return {
    ok: false,
    errors: [`tsc exited with status ${run.status} but produced no diagnostics; cannot validate the generated file`],
  };
}

function defaultTscRunner(tsconfigPath: string): TscRunResult {
  const result = spawnSync(resolveTscBin(), ["-p", tsconfigPath], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    timeout: TSC_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    spawnError: result.error ? result.error.message : undefined,
  };
}

/**
 * A `tsc --noEmit` validator that never executes the generated code. The
 * ephemeral tsconfig is always removed (even on spawn failure/timeout); the
 * generated `.ts` attempt file is never deleted.
 */
export function tscValidator(run: TscRunner = defaultTscRunner): Validator {
  return (stagedFilePath: string): ValidationResult => {
    const tsconfigPath = stagedFilePath.replace(/\.ts$/, "") + ".tsconfig.json";
    try {
      fs.writeFileSync(tsconfigPath, JSON.stringify(buildValidationTsconfig(stagedFilePath), null, 2));
      return interpretTscResult(run(tsconfigPath), stagedFilePath);
    } catch (err) {
      return {
        ok: false,
        errors: [`tsc validation could not run: ${err instanceof Error ? err.message : String(err)}`],
      };
    } finally {
      // Never delete the generated attempt file; only the ephemeral tsconfig.
      try {
        fs.rmSync(tsconfigPath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  };
}

/** Default model invoker: OpenAI Responses API. Requires OPENAI_API_KEY. */
export function defaultOpenAIInvoker(model = process.env.PINE_CONVERT_MODEL || "gpt-4.1"): ModelInvoker {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "No model credentials: set OPENAI_API_KEY (or run with --dry-run). Never commit keys.",
    );
  }
  return async ({ system, user }) => {
    const res = await callOpenAIResponses(user, system, "text", model, MAX_REPAIRS);
    const text = res.output?.[0]?.content?.[0]?.text;
    if (!text) throw new Error("Model returned no text output");
    return text;
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunConversionOptions {
  url: string;
  catalog?: CatalogEntry[];
  catalogPath?: string;
  invoke: ModelInvoker;
  validate: Validator;
  maxRepairs?: number;
  /** Writer for a given attempt; returns the staged path. Injectable for tests. */
  writeAttempt?: (slug: string, attempt: number, code: string) => string;
  /**
   * Static conformance checker, run on the generated code ONLY after a
   * successful `tsc` validation. Defaults to a no-op that always passes, so
   * callers exercising just the `tsc` loop are unaffected; the CLI injects the
   * real {@link ConformanceChecker} (via a dynamic import, to avoid a module
   * cycle). Error-severity findings drive repairs; warnings are reported only.
   */
  conformanceCheck?: ConformanceChecker;
  /**
   * Extracts the source-side unrepresentable feature ids used for the
   * conformance cross-check (produced by `detectUnrepresentableFeatures`).
   * Defaults to none; the CLI wires it to the real analyzer.
   */
  analyzeFeatures?: (source: string) => readonly string[];
}

function defaultWriteAttempt(runDir: string): (slug: string, attempt: number, code: string) => string {
  return (slug, attempt, code) =>
    writeStagedFile(path.join(runDir, `${slug}.attempt-${attempt}.ts`), code);
}

/**
 * Select → generate → validate → bounded repair. Returns a structured report.
 * At most `maxRepairs` (default 3) repair iterations run after the initial
 * generation; the loop stops immediately once the repair limit is reached.
 */
export async function runConversion(options: RunConversionOptions): Promise<ConversionReport> {
  const maxRepairs = options.maxRepairs ?? MAX_REPAIRS;
  const catalog = options.catalog ?? loadCatalog(options.catalogPath);
  const entry = selectStrategyByUrl(catalog, options.url);
  const version = assertConvertible(entry);
  const slug = slugFromUrl(entry.url);
  const name = entry.name?.trim() || entry.url;

  const writeAttempt =
    options.writeAttempt ?? defaultWriteAttempt(path.join(STAGING_DIR, slug));
  // Default to a no-op gate so callers that only test the tsc loop keep their
  // exact behaviour; the CLI injects the real checker.
  const conformanceCheck: ConformanceChecker =
    options.conformanceCheck ?? (() => ({ ok: true, findings: [] }));
  const analyzeFeatures = options.analyzeFeatures ?? (() => []);

  let attempts = 0;
  let repairAttempts = 0;
  let rawOutput = "";
  let code = "";
  let stagedFile: string | undefined;
  let result: ValidationResult = { ok: false, errors: [] };
  // Accumulate limitations across every attempt so a feature flagged by an
  // earlier attempt is never lost if a later repair omits it. Set preserves
  // first-seen order and deduplicates. This same accumulated set feeds the
  // conformance cross-check as the declared `@unsupported:` markers.
  const unsupportedFeatures = new Set<string>();

  // Conformance state reflects the MOST RECENT attempt. It is only populated
  // when that attempt passed `tsc` (conformance runs after type validation).
  let conformance: ConformanceResult = { ok: true, findings: [] };
  let conformanceRan = false;

  const buildConformanceContext = (): ConformanceContext => ({
    unrepresentableFeatures: analyzeFeatures(entry.source ?? ""),
    // Preserve every marker seen so far, not just the current attempt's.
    declaredUnsupported: [...unsupportedFeatures],
    name,
  });

  // Validate the current staged attempt: tsc first, then conformance only if
  // tsc passed. Resets conformance state when tsc fails so a stale pass from an
  // earlier attempt is never reported.
  const evaluateAttempt = (): void => {
    result = options.validate(stagedFile as string);
    if (result.ok) {
      conformance = conformanceCheck(code, buildConformanceContext());
      conformanceRan = true;
    } else {
      conformance = { ok: true, findings: [] };
      conformanceRan = false;
    }
  };

  // Error-severity findings are the only ones that drive repairs; warnings are
  // advisory and surfaced in the report instead.
  const conformanceErrorMessages = (): string[] =>
    conformanceRan
      ? conformance.findings.filter((f) => f.severity === "error").map((f) => f.message)
      : [];

  // An attempt is accepted only when it both type-checks and clears the
  // conformance gate. (When tsc fails, conformance did not run and defaults to
  // ok, but `result.ok` is false, so the attempt is still rejected.)
  const accepted = (): boolean => result.ok && conformance.ok;

  // Initial generation.
  rawOutput = await options.invoke(buildConversionPrompt(entry, version));
  code = extractTypeScript(rawOutput);
  for (const feature of parseUnsupportedFeatures(rawOutput)) unsupportedFeatures.add(feature);
  attempts += 1;
  stagedFile = writeAttempt(slug, 0, code);
  evaluateAttempt();

  // Bounded repair loop: repairs when tsc failed OR conformance flagged an
  // error. The repair budget is unchanged (default MAX_REPAIRS).
  while (!accepted() && repairAttempts < maxRepairs) {
    repairAttempts += 1;
    rawOutput = await options.invoke(
      buildRepairPrompt(entry, version, code, result.errors, conformanceErrorMessages()),
    );
    code = extractTypeScript(rawOutput);
    for (const feature of parseUnsupportedFeatures(rawOutput)) unsupportedFeatures.add(feature);
    attempts += 1;
    stagedFile = writeAttempt(slug, repairAttempts, code);
    evaluateAttempt();
    if (accepted()) break;
    // Stop immediately once the repair limit is reached.
  }

  const conformanceStatus: "passed" | "failed" | "skipped" = conformanceRan
    ? conformance.ok
      ? "passed"
      : "failed"
    : "skipped";

  return {
    url: entry.url,
    name,
    version,
    attempts,
    repairAttempts,
    validationStatus: result.ok ? "passed" : "failed",
    errors: result.ok ? [] : result.errors,
    unsupportedFeatures: [...unsupportedFeatures],
    stagedFile,
    conformance: {
      status: conformanceStatus,
      findings: conformanceRan ? conformance.findings : [],
    },
  };
}

/** Build a dry-run plan: selection + prompt metadata, no model call, no creds. */
export function planDryRun(url: string, catalogPath?: string): DryRunPlan {
  const entry = selectStrategyByUrl(loadCatalog(catalogPath), url);
  const version = assertConvertible(entry);
  const prompt = buildConversionPrompt(entry, version);
  return {
    url: entry.url,
    name: entry.name?.trim() || entry.url,
    version,
    scriptType: entry.script_type || "(unset; detected as strategy from source)",
    sourceChars: (entry.source ?? "").length,
    systemPromptChars: prompt.system.length,
    userPromptChars: prompt.user.length,
    systemPromptPreview: prompt.system.slice(0, 400),
    unsupportedRulesIncluded: prompt.system.includes("@unsupported:"),
    stagingTarget: path.join(STAGING_DIR, slugFromUrl(entry.url)),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) {
    console.error("Usage: bun scripts/pine-convert.ts --url=<catalog-url> [--dry-run | --run] [--model=<id>]");
    process.exit(2);
  }

  // Default to dry-run; a real model call requires explicit --run.
  const doRun = args.run === true;

  if (!doRun) {
    const plan = planDryRun(url, typeof args.catalog === "string" ? args.catalog : undefined);
    console.log(JSON.stringify({ mode: "dry-run", plan }, null, 2));
    return;
  }

  const model = typeof args.model === "string" ? args.model : undefined;
  const maxRepairs = typeof args["max-repairs"] === "string" ? Number(args["max-repairs"]) : MAX_REPAIRS;
  // Dynamic imports keep the conformance/features modules off pine-convert's
  // static import graph; they only load on --run.
  const { checkConformance } = await import("./pine-conformance");
  const { detectUnrepresentableFeatures } = await import("./pine-features");
  const report = await runConversion({
    url,
    catalogPath: typeof args.catalog === "string" ? args.catalog : undefined,
    invoke: defaultOpenAIInvoker(model),
    validate: tscValidator(),
    maxRepairs,
    conformanceCheck: checkConformance,
    analyzeFeatures: (source) => detectUnrepresentableFeatures(source),
  });
  console.log(JSON.stringify({ mode: "run", report }, null, 2));
  // Fail the run if the port never type-checked OR left an unresolved
  // conformance error. A "skipped" conformance (tsc failed) is already covered
  // by the validationStatus check.
  const succeeded =
    report.validationStatus === "passed" && report.conformance.status !== "failed";
  if (!succeeded) process.exit(1);
}

// Only run the CLI when executed directly, never when imported by tests.
if (/(^|[\\/])pine-convert\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
