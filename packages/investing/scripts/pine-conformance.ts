/**
 * Static conformance checker for GENERATED Pine→TypeScript ports.
 *
 * This is the layer the `tsc --noEmit` gate in `pine-convert.ts` cannot see: a
 * port can type-check perfectly and still diverge from the project's
 * signal-only strategy convention (wrong/absent exports, a disallowed import,
 * an impure call, or a source feature silently dropped without an
 * `// @unsupported:` marker). This module inspects the generated TypeScript
 * statically and returns structured findings.
 *
 * SCOPE AND HONESTY:
 *   - Pure, deterministic, offline. No network, no AI, no new dependencies, and
 *     it NEVER executes the generated code — all checks are string inspection.
 *   - It does NOT re-implement source-feature scoring. It reuses the shared
 *     feature catalog from `pine-features.ts` and consumes the caller-supplied
 *     `unrepresentableFeatures` (detected via that same module) to cross-check,
 *     rather than re-deriving them here.
 *   - Static detection proves PRESENCE/ABSENCE of textual patterns only. It
 *     does NOT prove semantic equivalence between the port and the Pine source,
 *     and an absent `@unsupported:` marker is reported as an unresolved WARNING,
 *     never treated as proof the feature was handled faithfully.
 *   - Heuristic checks (ones that cannot reliably prove the property) are
 *     emitted at `warn` severity; only reliably-detectable contract violations
 *     are `error`.
 */

import { PINE_FEATURES, stripLineComments } from "./pine-features";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConformanceSeverity = "error" | "warn";

export interface ConformanceFinding {
  /** Stable, machine-readable id (duplicates allowed, e.g. one per bad import). */
  id: string;
  severity: ConformanceSeverity;
  /** Human-readable explanation; may include specifics (an import path, etc.). */
  message: string;
}

export interface ConformanceResult {
  /** True when there are no `error`-severity findings. Warnings do NOT flip it. */
  ok: boolean;
  findings: ConformanceFinding[];
}

/**
 * The shape the converter depends on: given generated code and the source-side
 * context, return structured findings. {@link checkConformance} satisfies it.
 */
export type ConformanceChecker = (
  generatedSource: string,
  context: ConformanceContext,
) => ConformanceResult;

export interface ConformanceContext {
  /**
   * Feature ids the BENCHMARK flagged as unrepresentable for the Pine SOURCE
   * (`analyzeSource(source).unrepresentableFeatures`). Used only to cross-check
   * against declared markers — this module never re-derives them from source.
   */
  unrepresentableFeatures?: readonly string[];
  /**
   * The `// @unsupported:` marker texts parsed from the model output
   * (`parseUnsupportedFeatures`). Free-form; matched by keyword, never by exact
   * wording.
   */
  declaredUnsupported?: readonly string[];
  /** Strategy name, used only to contextualize messages. Never matched against code. */
  name?: string;
}

// ---------------------------------------------------------------------------
// Rule tables
// ---------------------------------------------------------------------------

/**
 * The approved import surface. The contract requires types to come ONLY from
 * these project aliases; anything else (npm packages, node builtins, relative
 * reach-ins) is flagged.
 */
export const ALLOWED_IMPORTS: readonly string[] = [
  "@/trading-agents/types",
  "@/stocks/quote-cache-service",
];

/**
 * Required module exports, matched by SHAPE not exact name (the `<Name>` part
 * is intentionally a wildcard so the check is not brittle to the strategy name).
 */
const REQUIRED_EXPORTS: ReadonlyArray<{ id: string; label: string; pattern: RegExp }> = [
  {
    id: "missing-export:evaluate-fn",
    label: "an exported `evaluate<Name>(bars, config?)` function",
    pattern: /export\s+(?:async\s+)?function\s+evaluate\w+\s*[(<]|export\s+const\s+evaluate\w+\s*[:=]/,
  },
  {
    id: "missing-export:config-interface",
    label: "an exported `<Name>Config` interface/type",
    pattern: /export\s+(?:interface|type)\s+\w*Config\b/,
  },
  {
    id: "missing-export:default-config",
    label: "an exported `DEFAULT_<NAME>_CONFIG` constant",
    pattern: /export\s+const\s+DEFAULT_\w+_CONFIG\b/,
  },
  {
    id: "missing-export:bar-type",
    label: "an exported `<Name>Bar` type",
    pattern: /export\s+(?:type|interface)\s+\w*Bar\b/,
  },
  {
    id: "missing-export:normalize-fn",
    label: "an exported `normalize<Name>Config()` validator",
    pattern: /export\s+(?:function\s+normalize\w*Config\s*[(<]|const\s+normalize\w*Config\s*[:=])/,
  },
];

/**
 * Impurity / non-determinism / offline-violation patterns. The contract forbids
 * network, randomness, wall-clock time and dynamic module loading inside a
 * strategy. Reliably-detectable calls are `error`; the wall-clock `new Date()`
 * heuristic is `warn` (a construction may have an argument we cannot see as a
 * literal).
 */
const IMPURITY_RULES: ReadonlyArray<{
  id: string;
  severity: ConformanceSeverity;
  label: string;
  pattern: RegExp;
}> = [
  { id: "impurity:date-now", severity: "error", label: "`Date.now()` (wall-clock time)", pattern: /\bDate\.now\s*\(/ },
  { id: "impurity:math-random", severity: "error", label: "`Math.random()` (non-deterministic)", pattern: /\bMath\.random\s*\(/ },
  { id: "impurity:fetch", severity: "error", label: "`fetch(` (network I/O)", pattern: /(?<![.\w])fetch\s*\(/ },
  { id: "impurity:dynamic-import", severity: "error", label: "dynamic `import(` ", pattern: /(?<![.\w])import\s*\(/ },
  { id: "impurity:require", severity: "error", label: "`require(` (module loading)", pattern: /(?<![.\w])require\s*\(/ },
  { id: "impurity:process", severity: "error", label: "`process.` (host environment access)", pattern: /(?<![.\w])process\s*\./ },
  { id: "impurity:wallclock-date", severity: "warn", label: "`new Date()` with no argument (likely wall-clock)", pattern: /new\s+Date\s*\(\s*\)/ },
];

/**
 * Keyword hints per unrepresentable feature id, used ONLY to decide whether a
 * free-text `@unsupported:` marker plausibly refers to that feature. Matching is
 * case-insensitive substring; wording never has to be exact. Falls back to the
 * feature's label words when an id is absent here.
 */
const FEATURE_KEYWORDS: Record<string, readonly string[]> = {
  trailingStop: ["trail"],
  pyramiding: ["pyramid", "scal"],
  requestSecurity: ["request.security", "security", "multi-timeframe", "multi timeframe", "multitimeframe", "timeframe", "htf"],
  positionSizing: ["position siz", "sizing", "qty", "quantity", "percent of equity", "percent_of_equity", "equity"],
  strategyExit: ["strategy.exit", "exit order", "exit"],
  stopLoss: ["stop loss", "stop-loss", "stoploss", "stop"],
  takeProfit: ["take profit", "take-profit", "takeprofit", "profit", "limit"],
};

const FEATURE_BY_ID = new Map(PINE_FEATURES.map((f) => [f.id, f]));

// ---------------------------------------------------------------------------
// Comment-stripping (so prose/JSDoc never trips a check)
// ---------------------------------------------------------------------------

/**
 * Remove `/* ... *\/` block comments (including JSDoc `/** *\/`) while preserving
 * string/template literals, so docstrings — which in these ports literally say
 * things like "no Date.now(), no randomness" — never trigger an impurity
 * finding. Pine source has no block comments, so this is TypeScript-specific
 * and is paired with the reused {@link stripLineComments} for `//` comments.
 */
export function stripBlockComments(source: string): string {
  const src = source ?? "";
  let out = "";
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 1; // land on the "/" of "*/"; loop's i++ steps past it
      out += " "; // keep token separation
      continue;
    }
    out += ch;
  }
  return out;
}

/** Strip block then line comments, leaving executable code (and string bodies). */
export function stripComments(source: string): string {
  return stripLineComments(stripBlockComments(source ?? ""));
}

// ---------------------------------------------------------------------------
// Individual checks (pure)
// ---------------------------------------------------------------------------

/** Collect static + side-effect import specifiers from comment-stripped code. */
export function extractImportSpecifiers(strippedCode: string): string[] {
  const specifiers: string[] = [];
  const fromRe = /\bimport\b[^;]*?\bfrom\s*["']([^"']+)["']/g;
  const sideEffectRe = /\bimport\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(strippedCode)) !== null) specifiers.push(m[1]);
  while ((m = sideEffectRe.exec(strippedCode)) !== null) specifiers.push(m[1]);
  return specifiers;
}

function checkRequiredExports(strippedCode: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const rule of REQUIRED_EXPORTS) {
    if (!rule.pattern.test(strippedCode)) {
      findings.push({
        id: rule.id,
        severity: "error",
        message: `Generated module is missing ${rule.label}, required by the strategy contract.`,
      });
    }
  }
  return findings;
}

function checkImports(strippedCode: string): ConformanceFinding[] {
  const allowed = new Set(ALLOWED_IMPORTS);
  const findings: ConformanceFinding[] = [];
  for (const spec of extractImportSpecifiers(strippedCode)) {
    if (!allowed.has(spec)) {
      findings.push({
        id: "disallowed-import",
        severity: "error",
        message: `Import from "${spec}" is outside the approved aliases (${ALLOWED_IMPORTS.join(", ")}); the port must not add dependencies or reach into package internals.`,
      });
    }
  }
  return findings;
}

function checkImpurity(strippedCode: string): ConformanceFinding[] {
  const findings: ConformanceFinding[] = [];
  for (const rule of IMPURITY_RULES) {
    if (rule.pattern.test(strippedCode)) {
      findings.push({
        id: rule.id,
        severity: rule.severity,
        message:
          rule.severity === "error"
            ? `Generated module uses ${rule.label}; strategies must be pure, deterministic and offline.`
            : `Generated module appears to use ${rule.label}; timestamps should come from each bar's own date. Verify this is not wall-clock time.`,
      });
    }
  }
  return findings;
}

/**
 * Warm-up/HOLD guard HEURISTIC. A faithful port forces HOLD until the longest
 * lookback is satisfied, which these ports express with a `warmup` concept
 * and/or a `HOLD` action literal. Absence of BOTH signals is a (heuristic)
 * warning — it cannot prove the guard is missing, only that no textual trace of
 * one was found.
 */
function checkWarmupGuard(strippedCode: string): ConformanceFinding[] {
  const hasWarmup = /warm[\s_-]?up/i.test(strippedCode);
  const hasHold = /["'`]HOLD["'`]/.test(strippedCode);
  if (hasWarmup || hasHold) return [];
  return [
    {
      id: "missing-warmup-guard",
      severity: "warn",
      message:
        "Heuristic: no warm-up concept or 'HOLD' action literal was found. A faithful port should force HOLD until enough bars exist for the longest lookback. Confirm the warm-up window is handled.",
    },
  ];
}

function keywordsForFeature(id: string): readonly string[] {
  if (FEATURE_KEYWORDS[id]) return FEATURE_KEYWORDS[id];
  const label = FEATURE_BY_ID.get(id)?.label ?? id;
  return label
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

/**
 * Cross-check: every source feature the benchmark marked unrepresentable should
 * be acknowledged by a declared `@unsupported:` marker. A missing acknowledgement
 * is a WARNING (the keyword match is heuristic, and the feature could in
 * principle be re-expressed faithfully) — it is explicitly NOT treated as proof
 * the feature was dropped, nor is its absence treated as proof it was handled.
 */
function checkUnsupportedDeclarations(context: ConformanceContext): ConformanceFinding[] {
  const unrepresentable = context.unrepresentableFeatures ?? [];
  const declared = (context.declaredUnsupported ?? []).map((d) => d.toLowerCase());
  const findings: ConformanceFinding[] = [];
  for (const id of unrepresentable) {
    const keywords = keywordsForFeature(id);
    const acknowledged = declared.some((marker) => keywords.some((k) => marker.includes(k)));
    if (!acknowledged) {
      const label = FEATURE_BY_ID.get(id)?.label ?? id;
      findings.push({
        id: `undeclared-unsupported:${id}`,
        severity: "warn",
        message:
          `Source uses "${label}" which TradeSignal cannot represent faithfully, but no matching ` +
          `// @unsupported: marker was declared. Confirm it was intentionally re-expressed (e.g. as reasoning text) ` +
          `rather than silently approximated.`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run every static conformance check over a generated port. Findings are
 * returned in a fixed order (exports → imports → impurity → warm-up →
 * unsupported cross-check) so the result is deterministic. `ok` is true iff no
 * `error`-severity finding is present; warnings never flip it.
 */
export function checkConformance(
  generatedSource: string,
  context: ConformanceContext = {},
): ConformanceResult {
  const stripped = stripComments(generatedSource ?? "");
  const findings: ConformanceFinding[] = [
    ...checkRequiredExports(stripped),
    ...checkImports(stripped),
    ...checkImpurity(stripped),
    ...checkWarmupGuard(stripped),
    ...checkUnsupportedDeclarations(context),
  ];
  return {
    ok: !findings.some((f) => f.severity === "error"),
    findings,
  };
}

/** Convenience: the subset of findings the repair loop can act on. */
export function actionableFindings(result: ConformanceResult): ConformanceFinding[] {
  return result.findings.filter((f) => f.severity === "error");
}
