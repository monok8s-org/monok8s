// L1 unit tests for the bench regression checker (#189 B2). Hermetic
// — all behavior lives behind pure functions; the orchestration
// path injects fs reads so tests assert without touching disk.

import { describe, expect, test } from "@jest/globals";

import {
  checkAgainstBaseline,
  discoverRuns,
  extractBenchName,
  parseBenchOutput,
  run,
  type Baseline,
  type BenchResult,
  type DiscoveredRun,
} from "./check_regression";

const PGBENCH_SAMPLE = `pgbench (16.0)
transaction type: tenants_find_by_id.sql
scaling factor: 1
query mode: simple
number of clients: 4
number of threads: 2
number of transactions actually processed: 200/200
latency average = 1.234 ms
latency stddev = 0.567 ms
initial connection time = 89.123 ms
tps = 1234.567890 (without initial connection time)
statement latencies in milliseconds and failures:
         0.123           0  SELECT * FROM tenants WHERE id = '...'::uuid;
`;

// ── parseBenchOutput ─────────────────────────────────────────────────────────

describe("parseBenchOutput", () => {
  test("extracts TPS", () => {
    expect(parseBenchOutput(PGBENCH_SAMPLE).tps).toBeCloseTo(1234.56789, 4);
  });

  test("extracts the statement-latency row", () => {
    const result = parseBenchOutput(PGBENCH_SAMPLE);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]!.latencyMs).toBeCloseTo(0.123);
    expect(result.statements[0]!.query).toContain("SELECT * FROM tenants");
  });

  test("throws when TPS line missing", () => {
    expect(() => parseBenchOutput("garbage\n")).toThrow(/TPS line not found/);
  });

  test("throws when statement-latencies block missing", () => {
    const broken =
      "tps = 100.0 (without initial connection time)\nno block here\n";
    expect(() => parseBenchOutput(broken)).toThrow(/statement-latencies block/);
  });
});

// ── checkAgainstBaseline ─────────────────────────────────────────────────────

function fixtureResult(tps: number, latencyMs: number): BenchResult {
  return {
    tps,
    statements: [
      {
        latencyMs,
        query: "SELECT * FROM tenants WHERE id = '...'::uuid;",
      },
    ],
  };
}

function fixtureBaseline(tps: number, latencyMs: number): Baseline {
  return {
    tps,
    statements: [
      {
        latency_ms: latencyMs,
        query_fragment: "SELECT * FROM tenants WHERE id =",
      },
    ],
  };
}

describe("checkAgainstBaseline", () => {
  test("no findings when within threshold", () => {
    expect(
      checkAgainstBaseline(
        "tenants_find_by_id",
        fixtureResult(1000, 1.0),
        fixtureBaseline(1000, 1.0),
      ),
    ).toEqual([]);
  });

  test("TPS drop > 2× flags", () => {
    const findings = checkAgainstBaseline(
      "tenants_find_by_id",
      fixtureResult(400, 1.0),
      fixtureBaseline(1000, 1.0),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.metric).toBe("tps");
  });

  test("TPS drop just under 2× passes", () => {
    // baseline 1000, measured 501 → 501 > 500 = 1000/2 → pass
    expect(
      checkAgainstBaseline(
        "tenants_find_by_id",
        fixtureResult(501, 1.0),
        fixtureBaseline(1000, 1.0),
      ),
    ).toEqual([]);
  });

  test("latency rise > 2× flags", () => {
    const findings = checkAgainstBaseline(
      "tenants_find_by_id",
      fixtureResult(1000, 2.5),
      fixtureBaseline(1000, 1.0),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.metric).toBe("statement_latency");
  });

  test("missing statement flags", () => {
    const result: BenchResult = {
      tps: 1000,
      statements: [{ latencyMs: 1.0, query: "UPDATE other_table SET ..." }],
    };
    const findings = checkAgainstBaseline(
      "tenants_find_by_id",
      result,
      fixtureBaseline(1000, 1.0),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.metric).toBe("statement_missing");
  });

  test("empty baseline → no findings", () => {
    expect(
      checkAgainstBaseline(
        "tenants_find_by_id",
        fixtureResult(1, 999),
        {},
      ),
    ).toEqual([]);
  });
});

// ── extractBenchName ─────────────────────────────────────────────────────────

describe("extractBenchName", () => {
  test("typical slug", () => {
    expect(
      extractBenchName(
        "bazel-testlogs-packages-db-bench_tenants_find_by_id-test.log",
      ),
    ).toBe("tenants_find_by_id");
  });

  test("trimmed slug (prefix stripped) still matches", () => {
    expect(
      extractBenchName("packages-db-bench_users_find_by_id-test.log"),
    ).toBe("users_find_by_id");
  });

  test("unrecognized returns null", () => {
    expect(extractBenchName("random.txt")).toBeNull();
  });
});

// ── run (orchestration with injected fs) ─────────────────────────────────────

describe("run", () => {
  test("PASS when every bench is within threshold", () => {
    const runs: DiscoveredRun[] = [
      {
        benchName: "tenants_find_by_id",
        logPath: "/fake/tenants.log",
      },
    ];
    const outcome = run("/results", "/baseline", {
      discoverRuns: () => runs,
      readLog: () => PGBENCH_SAMPLE,
      readBaseline: () =>
        fixtureBaseline(1000, 1.0),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.findings).toEqual([]);
    expect(outcome.runs).toBe(1);
  });

  test("FAIL when regression detected", () => {
    const runs: DiscoveredRun[] = [
      {
        benchName: "tenants_find_by_id",
        logPath: "/fake/tenants.log",
      },
    ];
    const outcome = run("/results", "/baseline", {
      discoverRuns: () => runs,
      readLog: () => PGBENCH_SAMPLE,
      readBaseline: () =>
        // Baseline TPS 10000 vs measured 1234 → 8× below → flag.
        ({ tps: 10000, statements: [] }),
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.findings.length).toBeGreaterThan(0);
  });

  test("PASS when no bench logs discovered", () => {
    const outcome = run("/results", "/baseline", {
      discoverRuns: () => [],
      readLog: () => "",
      readBaseline: () => null,
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.runs).toBe(0);
  });

  test("missing baseline is reported, not failed", () => {
    const outcome = run("/results", "/baseline", {
      discoverRuns: () => [
        { benchName: "tenants_find_by_id", logPath: "/fake/tenants.log" },
      ],
      readLog: () => PGBENCH_SAMPLE,
      readBaseline: () => null, // ENOENT
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.findings).toEqual([]);
    expect(outcome.lines.join("\n")).toContain("no baseline");
  });

  test("parse failure is reported as a finding (not a throw)", () => {
    const outcome = run("/results", "/baseline", {
      discoverRuns: () => [
        { benchName: "tenants_find_by_id", logPath: "/fake/tenants.log" },
      ],
      readLog: () => "garbage\n",
      readBaseline: () => fixtureBaseline(1000, 1.0),
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]!.metric).toBe("parse");
  });
});

// ── discoverRuns (filesystem touchpoint — smoke only) ────────────────────────

describe("discoverRuns", () => {
  test("returns runs from a temp dir with mixed files", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bench-rg-"));
    fs.writeFileSync(
      path.join(tmp, "bazel-testlogs-packages-db-bench_a-test.log"),
      "x",
    );
    fs.writeFileSync(
      path.join(tmp, "bazel-testlogs-packages-db-bench_b-test.log"),
      "y",
    );
    fs.writeFileSync(path.join(tmp, "EMPTY.txt"), "noise");
    const names = discoverRuns(tmp)
      .map((r) => r.benchName)
      .sort();
    expect(names).toEqual(["a", "b"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
