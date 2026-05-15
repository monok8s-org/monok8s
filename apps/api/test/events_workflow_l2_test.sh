#!/usr/bin/env bash
# L2 itest launcher for events_workflow_l2_test.ts (#177 / #88b).
# Same shape as events_l2_test.sh from #178; only the driver path differs.

set -euo pipefail

: "${NATS_URL:?NATS_URL must be set by itest_suite}"

runfiles="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"
root="${runfiles}/_main"

[[ -d "${root}/packages/auth/src" ]] || {
    echo "events_workflow_l2: packages/auth/src/ not in runfiles at ${root}" >&2
    exit 1
}

driver="${root}/apps/api/test/events_workflow_l2_test.js"
[[ -f "$driver" ]] || {
    echo "events_workflow_l2: events_workflow_l2_test.js not found at ${driver}" >&2
    exit 1
}

loader="${root}/tools/bazel/monok8s-esm-loader.mjs"
[[ -f "$loader" ]] || {
    echo "events_workflow_l2: monok8s-esm-loader.mjs not found at ${loader}" >&2
    exit 1
}

cd "$root"
NODE_PATH="${root}/node_modules:${runfiles}/node_modules" \
MONOK8S_PACKAGES_ROOT="${root}/packages" \
    node \
        --experimental-eventsource \
        --import "file://${loader}" \
        "$driver"
