#!/usr/bin/env bash
# L2 test wrapper for pool_l2_test.ts (#85).
#
# Runs under rules_pg's pg_test launcher: PGHOST/PGPORT/PGUSER/PGPASSWORD
# point at the ephemeral Postgres instance. Bootstraps two tenant
# databases on it, then runs the compiled Node.js test driver which
# exercises makePoolFactory across both.

set -euo pipefail

: "${PGHOST:?PGHOST must be set by pg_test launcher}"
: "${PGPORT:?PGPORT must be set by pg_test launcher}"
: "${PGUSER:?PGUSER must be set by pg_test launcher}"
export PGPASSWORD="${PGPASSWORD:-}"

# Locate the compiled driver via Bazel runfiles.
runfiles="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"
driver=$(find "$runfiles" -path '*packages/db/test/pool_l2_test.js' 2>/dev/null | head -1)
[[ -f "$driver" ]] || { echo "smoke: pool_l2_test.js not found under $runfiles" >&2; exit 1; }

# Create the two per-tenant databases on the ephemeral instance.
# rules_pg's launcher creates a default `PGDATABASE` (usually `postgres`)
# we can connect to as admin to issue CREATE DATABASE.
psql="psql -X -v ON_ERROR_STOP=1"
${psql} -d postgres -c "CREATE DATABASE tenant_alpha_db" \
    || ${psql} -d "${PGDATABASE:-postgres}" -c "CREATE DATABASE tenant_alpha_db"
${psql} -d postgres -c "CREATE DATABASE tenant_beta_db" \
    || ${psql} -d "${PGDATABASE:-postgres}" -c "CREATE DATABASE tenant_beta_db"

# Run the TS-compiled driver. node resolves runfiles relative to the
# driver's directory so we need a node_modules tree near it — Bazel
# arranges this via the jest_test's `node_modules` attr OR via the
# runfiles tree's symlinks. For this test we use the shared
# //:node_modules tree by setting NODE_PATH.
NODE_PATH="${runfiles}/_main/node_modules:${runfiles}/node_modules" \
    node "$driver"
