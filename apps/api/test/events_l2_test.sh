#!/usr/bin/env bash
# L2 itest launcher for events_l2_test.ts (#88a, re-introduced via #178).
#
# itest_suite exports NATS_URL pointing at the rules_nats-managed
# server. The launcher:
#   1. cd into the runfiles _main tree so relative paths to compiled
#      packages resolve.
#   2. Set MONOK8S_PACKAGES_ROOT for the ESM loader hook so
#      `@monok8s/*` imports resolve to compiled packages/*/src/index.js.
#   3. Invoke node with --import for the ESM loader.

set -euo pipefail

: "${NATS_URL:?NATS_URL must be set by itest_suite}"

runfiles="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"
root="${runfiles}/_main"

# Defense in depth: confirm the runfiles tree shape matches expectation
# before invoking node.
[[ -d "${root}/packages/auth/src" ]] || {
    echo "events_l2: packages/auth/src/ not in runfiles at ${root}" >&2
    exit 1
}

driver="${root}/apps/api/test/events_l2_test.js"
[[ -f "$driver" ]] || {
    echo "events_l2: events_l2_test.js not found at ${driver}" >&2
    exit 1
}

loader="${root}/tools/bazel/monok8s-esm-loader.mjs"
[[ -f "$loader" ]] || {
    echo "events_l2: monok8s-esm-loader.mjs not found at ${loader}" >&2
    exit 1
}

cd "$root"
# --experimental-eventsource exposes Node 22's WHATWG EventSource on
# globalThis. tRPC v11's httpSubscriptionLink reads it from there.
NODE_PATH="${root}/node_modules:${runfiles}/node_modules" \
MONOK8S_PACKAGES_ROOT="${root}/packages" \
    node \
        --experimental-eventsource \
        --import "file://${loader}" \
        "$driver"
