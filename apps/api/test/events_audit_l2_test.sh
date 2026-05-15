#!/usr/bin/env bash
# L2 itest launcher for events_audit_l2_test.ts (#179 / #88c).
#
# itest_suite exports NATS_URL + PG_URL pointing at the rules_nats +
# rules_pg-managed servers. The launcher:
#   1. cd into the runfiles _main tree so relative paths to compiled
#      packages resolve.
#   2. Set MONOK8S_PACKAGES_ROOT for the ESM loader hook so
#      `@monok8s/*` imports resolve to compiled packages/*/src/index.js.
#   3. Pass the audit_log migration SQL path via MONOK8S_AUDIT_LOG_SQL
#      so the test can apply the schema to the ephemeral pg before
#      exercising the audit flow.
#   4. Invoke node with --import for the ESM loader.

set -euo pipefail

: "${NATS_URL:?NATS_URL must be set by itest_suite}"
: "${PG_URL:?PG_URL must be set by itest_suite}"

runfiles="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"
root="${runfiles}/_main"

# Defense in depth: confirm the runfiles tree shape matches expectation
# before invoking node.
[[ -d "${root}/packages/auth/src" ]] || {
    echo "events_audit_l2: packages/auth/src/ not in runfiles at ${root}" >&2
    exit 1
}

driver="${root}/apps/api/test/events_audit_l2_test.js"
[[ -f "$driver" ]] || {
    echo "events_audit_l2: events_audit_l2_test.js not found at ${driver}" >&2
    exit 1
}

loader="${root}/tools/bazel/monok8s-esm-loader.mjs"
[[ -f "$loader" ]] || {
    echo "events_audit_l2: monok8s-esm-loader.mjs not found at ${loader}" >&2
    exit 1
}

migration="${root}/packages/db/migrations/008_audit_log.sql"
[[ -f "$migration" ]] || {
    echo "events_audit_l2: 008_audit_log.sql not found at ${migration}" >&2
    exit 1
}

cd "$root"
NODE_PATH="${root}/node_modules:${runfiles}/node_modules" \
MONOK8S_PACKAGES_ROOT="${root}/packages" \
MONOK8S_AUDIT_LOG_SQL="${migration}" \
    node \
        --experimental-eventsource \
        --import "file://${loader}" \
        "$driver"
