#!/usr/bin/env bash
# packages/db/bench/users_find_by_id_bench.sh
#
# Phase B (#189 / #166). Second bench target — exercises
# users.findById against a 10K-row fixture. Mirrors the
# tenants_find_by_id_bench.sh shape so adding additional benches is
# a copy-modify-fixture pattern rather than a per-table launcher
# design exercise.

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

BENCH_SCRIPT="packages/db/bench/users_find_by_id.sql"
[[ -f "$BENCH_SCRIPT" ]] || {
    echo "ERROR: bench script not found at $BENCH_SCRIPT (cwd=$PWD)" >&2
    exit 1
}

psql() {
    PGPASSWORD="$PGPASSWORD" command psql \
        -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
        --no-password -v ON_ERROR_STOP=1 -t -A "$@"
}

echo "--- bench: users_find_by_id ---"
echo "    pg: $PGUSER@$PGHOST:$PGPORT/$PGDATABASE"

# Seed the FK target — bench tenant must exist before users reference it.
psql -c "INSERT INTO tenants (id, slug, plan)
         VALUES ('00000000-0000-0000-0000-000000000001', 'bench', 'starter')
         ON CONFLICT (id) DO NOTHING;" >/dev/null

# Seed the canonical bench user (deterministic UUID — the .sql script
# queries this id). zitadel_id is UNIQUE so it carries the deterministic
# value too.
psql -c "INSERT INTO users (id, tenant_id, zitadel_id, email)
         VALUES ('00000000-0000-0000-0000-000000000002',
                 '00000000-0000-0000-0000-000000000001',
                 'bench-zitadel-canonical',
                 'bench@monok8s.test')
         ON CONFLICT (id) DO NOTHING;" >/dev/null

# Pad with 9,999 additional users referencing the same tenant. zitadel_id
# uses generate_series so the UNIQUE constraint stays satisfied.
psql -c "INSERT INTO users (id, tenant_id, zitadel_id, email)
         SELECT gen_random_uuid(),
                '00000000-0000-0000-0000-000000000001',
                'bench-zitadel-' || n,
                'bench-' || n || '@monok8s.test'
         FROM generate_series(1, 9999) AS s(n)
         ON CONFLICT DO NOTHING;" >/dev/null
psql -c "ANALYZE users;" >/dev/null
echo "    seeded 10K users"

PGPASSWORD="$PGPASSWORD" pgbench \
    -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --client=4 \
    --jobs=2 \
    --transactions=50 \
    --file="$BENCH_SCRIPT" \
    --report-per-command \
    --no-vacuum

echo "--- bench: PASS ---"
