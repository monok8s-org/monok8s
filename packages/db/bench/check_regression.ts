// Threshold-based regression detection for pgbench output (#189 B2).
//
// Phase B of the bench-suite story. Phase A (#188) scaffolded one
// bench target; this module turns the raw pgbench stdout into a
// structured result and compares it against a committed baseline.
//
// Usage from the bench GHA workflow:
//
//   bazel run //packages/db/bench:check_regression -- \
//       <bench-results-dir> <baseline-dir>
//
// Each `<bench-results-dir>/<slug>` file is a copy of the
// corresponding bench target's `test.log`. The slug encodes the
// originating target; `extractBenchName` pulls the bench name out
// via the `*-bench_<name>-test.log` suffix convention emitted by
// the GHA `Collect bench output` step.
//
// Baseline files live at `<baseline-dir>/<bench-name>.json` with the
// schema:
//
//   {
//     "tps": 1234.56,
//     "statements": [
//       { "latency_ms": 0.123,
//         "query_fragment": "SELECT * FROM tenants WHERE id =" }
//     ]
//   }
//
// Fail condition (matches AC):
//   - measured TPS < baseline.tps / 2 → regression
//   - any measured statement latency > 2 * baseline_latency_ms → regression
//
// The query_fragment match is a prefix check on the pgbench
// statement line so trivial whitespace / case drift doesn't flip
// the gate. Pure logic + a thin file-IO orchestration boundary so
// every behavior-carrying function is plain-call-testable from
// jest with synthetic strings.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// ── parse pgbench output ─────────────────────────────────────────────────────

// `tps = 1234.567890 (without initial connection time)` — the
// post-connection TPS line. The other tps line ("including initial
// connection time") is the noisier metric; we pin the cleaner one.
const TPS_RE = /^tps = ([\d.]+) \(without initial connection time\)/m;

// Statement-latencies block emitted by `pgbench --report-per-command`.
// Each line: `    0.123    0    SELECT * FROM …`. We pull the latency
// + the trailing query text.
const STATEMENT_RE = /^\s+([\d.]+)\s+\d+\s+(\S.*?)\s*$/;
const STATEMENT_BLOCK_HEAD = "statement latencies in milliseconds and failures:";

export interface StatementResult {
  latencyMs: number;
  query: string;
}

export interface BenchResult {
  tps: number;
  statements: StatementResult[];
}

export interface BaselineStatement {
  latency_ms: number;
  query_fragment: string;
}

export interface Baseline {
  tps?: number;
  statements?: BaselineStatement[];
}

export interface RegressionFinding {
  benchName: string;
  metric: "tps" | "statement_latency" | "statement_missing" | "parse";
  measured: number;
  baseline: number;
  detail: string;
}

export function parseBenchOutput(text: string): BenchResult {
  const tpsMatch = TPS_RE.exec(text);
  if (!tpsMatch) {
    throw new Error("pgbench TPS line not found in output");
  }
  const tps = Number(tpsMatch[1]);

  const blockIdx = text.indexOf(STATEMENT_BLOCK_HEAD);
  if (blockIdx < 0) {
    throw new Error("statement-latencies block not found in output");
  }
  const block = text.slice(blockIdx + STATEMENT_BLOCK_HEAD.length);
  const statements: StatementResult[] = [];
  for (const line of block.split("\n")) {
    const m = STATEMENT_RE.exec(line);
    if (m) {
      statements.push({
        latencyMs: Number(m[1]),
        query: m[2]!,
      });
    }
  }

  return { tps, statements };
}

// ── compare against baseline ─────────────────────────────────────────────────

export function checkAgainstBaseline(
  benchName: string,
  result: BenchResult,
  baseline: Baseline,
  threshold = 2.0,
): RegressionFinding[] {
  const findings: RegressionFinding[] = [];

  const baselineTps = baseline.tps ?? 0;
  if (baselineTps > 0 && result.tps < baselineTps / threshold) {
    findings.push({
      benchName,
      metric: "tps",
      measured: result.tps,
      baseline: baselineTps,
      detail:
        `TPS dropped > ${threshold}× — measured ${result.tps.toFixed(1)},` +
        ` baseline ${baselineTps.toFixed(1)}`,
    });
  }

  for (const stmt of baseline.statements ?? []) {
    if (!stmt.query_fragment || stmt.latency_ms <= 0) continue;
    const matched = result.statements.find((s) =>
      s.query.startsWith(stmt.query_fragment),
    );
    if (matched === undefined) {
      findings.push({
        benchName,
        metric: "statement_missing",
        measured: 0,
        baseline: stmt.latency_ms,
        detail: `baseline statement ${JSON.stringify(stmt.query_fragment)} not present in output`,
      });
      continue;
    }
    if (matched.latencyMs > stmt.latency_ms * threshold) {
      findings.push({
        benchName,
        metric: "statement_latency",
        measured: matched.latencyMs,
        baseline: stmt.latency_ms,
        detail:
          `latency rose > ${threshold}× — measured ${matched.latencyMs.toFixed(3)} ms,` +
          ` baseline ${stmt.latency_ms.toFixed(3)} ms` +
          ` (${JSON.stringify(stmt.query_fragment)})`,
      });
    }
  }

  return findings;
}

// ── file discovery + orchestration ───────────────────────────────────────────

// GHA artifact slug shape:
// `bazel-testlogs-packages-db-bench_<name>-test.log`. The trailing
// `bench_<name>-test.log` segment is the addressable handle; the
// `bazel-testlogs-` prefix is optional (the workflow's sed pipeline
// strips it).
const SLUG_RE = /.*bench_([A-Za-z0-9_]+)-test\.log$/;

export function extractBenchName(slug: string): string | null {
  const m = SLUG_RE.exec(slug);
  return m ? m[1]! : null;
}

export interface DiscoveredRun {
  benchName: string;
  logPath: string;
}

export function discoverRuns(resultsDir: string): DiscoveredRun[] {
  const out: DiscoveredRun[] = [];
  for (const entry of readdirSync(resultsDir).sort()) {
    const full = join(resultsDir, entry);
    if (!statSync(full).isFile()) continue;
    const name = extractBenchName(entry);
    if (name !== null) {
      out.push({ benchName: name, logPath: full });
    }
  }
  return out;
}

export interface RunOutcome {
  exitCode: number;
  findings: RegressionFinding[];
  runs: number;
  lines: string[];
}

// run — pure orchestration over injected fs reads. Returns the exit
// code + findings + the lines that would have been printed. The CLI
// entrypoint writes lines to stdout; tests assert on the structured
// fields without touching the console.
export function run(
  resultsDir: string,
  baselineDir: string,
  fsReads: {
    discoverRuns?: (resultsDir: string) => DiscoveredRun[];
    readLog?: (path: string) => string;
    readBaseline?: (path: string) => Baseline | null;
  } = {},
): RunOutcome {
  const discover = fsReads.discoverRuns ?? discoverRuns;
  const readLog = fsReads.readLog ?? ((p) => readFileSync(p, "utf8"));
  const readBaseline =
    fsReads.readBaseline ??
    ((p) => {
      try {
        return JSON.parse(readFileSync(p, "utf8")) as Baseline;
      } catch (e) {
        if (
          e instanceof Error &&
          "code" in e &&
          (e as { code?: string }).code === "ENOENT"
        ) {
          return null;
        }
        throw e;
      }
    });

  const runs = discover(resultsDir);
  const lines: string[] = [];
  const findings: RegressionFinding[] = [];

  if (runs.length === 0) {
    lines.push(`no recognized bench logs found under ${resultsDir}`);
    return { exitCode: 0, findings, runs: 0, lines };
  }

  for (const { benchName, logPath } of runs) {
    const baselinePath = join(baselineDir, `${benchName}.json`);
    const baseline = readBaseline(baselinePath);
    if (baseline === null) {
      lines.push(
        `⚠  ${benchName}: no baseline at ${baselinePath} — skipped`,
      );
      continue;
    }
    let result: BenchResult;
    try {
      result = parseBenchOutput(readLog(logPath));
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      lines.push(`✗  ${benchName}: parse failed — ${detail}`);
      findings.push({
        benchName,
        metric: "parse",
        measured: 0,
        baseline: 0,
        detail,
      });
      continue;
    }
    const benchFindings = checkAgainstBaseline(benchName, result, baseline);
    if (benchFindings.length > 0) {
      lines.push(`✗  ${benchName}: ${benchFindings.length} regression(s)`);
      for (const f of benchFindings) lines.push(`     - ${f.detail}`);
    } else {
      lines.push(
        `✓  ${benchName}: tps=${result.tps.toFixed(1)},` +
          ` statements=${result.statements.length}`,
      );
    }
    findings.push(...benchFindings);
  }

  if (findings.length > 0) {
    lines.push(
      `\nFAIL: ${findings.length} regression(s) across ${runs.length} bench run(s)`,
    );
    return { exitCode: 1, findings, runs: runs.length, lines };
  }
  lines.push(`\nPASS: ${runs.length} bench run(s) within threshold`);
  return { exitCode: 0, findings, runs: runs.length, lines };
}
