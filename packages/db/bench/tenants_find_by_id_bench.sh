#!/usr/bin/env bash
# packages/db/bench/tenants_find_by_id_bench.sh
#
# Phase A scaffolded; Phase B (#189) widens to a 10K-row fixture so
# the indexed lookup path matters. Drives pgbench against
# tenants_find_by_id.sql for a fixed transaction count across a
# small client pool. Hermetic via rules_pg's pg_test which exports
# PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD and adds the bundled
# bin/ directory to PATH (so `psql` + `pgbench` resolve).
#
# The schema target (`:schema`) applies the canonical migrations so
# the `tenants` table exists before this launcher's INSERT runs.
#
# Phase B regression detection: GHA workflow captures stdout to
# artifact storage; //packages/db/bench:check_regression compares
# parsed TPS + per-statement latency against
# packages/db/bench/baseline/tenants_find_by_id.json. Threshold 2×.

set -euo pipefail

require_env() {
    local var="$1"
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var not set — pg_test launcher should have set it" >&2
        exit 1
    fi
}
require_env PGHOST
require_env PGPORT
require_env PGDATABASE
require_env PGUSER
require_env PGPASSWORD

# Resolve the bench script via runfiles. pg_test's launcher cd's into
# the runfiles tree before exec'ing this script, so the path is
# repo-relative from there.
BENCH_SCRIPT="packages/db/bench/tenants_find_by_id.sql"
[[ -f "$BENCH_SCRIPT" ]] || {
    echo "ERROR: bench script not found at $BENCH_SCRIPT (cwd=$PWD)" >&2
    exit 1
}

psql() {
    PGPASSWORD="$PGPASSWORD" command psql \
        -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
        --no-password -v ON_ERROR_STOP=1 -t -A "$@"
}

echo "--- bench: tenants_find_by_id ---"
echo "    pg: $PGUSER@$PGHOST:$PGPORT/$PGDATABASE"

# Seed the canonical bench row first (deterministic UUID — the .sql
# script queries this id).
psql -c "INSERT INTO tenants (id, slug, plan)
         VALUES ('00000000-0000-0000-0000-000000000001', 'bench', 'starter')
         ON CONFLICT (id) DO NOTHING;" >/dev/null

# Phase B fixture (#189 B3) — pad with 9,999 additional tenants so
# the lookup hits a populated index path rather than a 1-row table.
# generate_series + gen_random_uuid is faster than per-row INSERT
# loops and avoids the slug-uniqueness collision that hand-built
# UUIDs would invite.
psql -c "INSERT INTO tenants (id, slug, plan)
         SELECT gen_random_uuid(),
                'bench-' || n,
                CASE WHEN n % 10 = 0 THEN 'pro' ELSE 'starter' END
         FROM generate_series(1, 9999) AS s(n)
         ON CONFLICT DO NOTHING;" >/dev/null
psql -c "ANALYZE tenants;" >/dev/null
echo "    seeded 10K tenants"

# pgbench run. Conservative defaults for Phase A — small client pool,
# fixed transaction count, no warmup. Phase B will widen these.
# pgbench picks up PGPASSWORD from the env, no --no-password flag
# (pgbench doesn't take that — it's a psql-only flag).
PGPASSWORD="$PGPASSWORD" pgbench \
    -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --client=4 \
    --jobs=2 \
    --transactions=50 \
    --file="$BENCH_SCRIPT" \
    --report-per-command \
    --no-vacuum

echo "--- bench: PASS ---"
