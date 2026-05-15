#!/usr/bin/env bash
# Asserts collect_bench_logs.sh walks a fixture testlogs tree, copies
# only the `bench_*` test.log files into the output dir, and slugifies
# their paths into the form `pkg-path-bench_<name>-test.log`. Also
# covers the "no matches → EMPTY.txt" fallback.

set -euo pipefail

SCRIPT_REL="${1:?missing path to collect_bench_logs.sh}"
# Absolutize before any subshell cd's so the path stays valid.
SCRIPT="$(readlink -f "$SCRIPT_REL")"
[[ -x "$SCRIPT" ]] || chmod +x "$SCRIPT"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Fixture testlogs tree mirroring the absolute-path shape produced by
# `bazel info bazel-testlogs` (i.e. `.../testlogs/<pkg-path>/<target>/test.log`).
mkdir -p "$TMP/bazel-out/k8-fastbuild/testlogs/packages/db/bench_alpha"
mkdir -p "$TMP/bazel-out/k8-fastbuild/testlogs/packages/db/bench_beta"
mkdir -p "$TMP/bazel-out/k8-fastbuild/testlogs/packages/db/non_bench_target"
mkdir -p "$TMP/bazel-out/k8-fastbuild/testlogs/apps/api/bench_gamma"
echo "tps = 100" > "$TMP/bazel-out/k8-fastbuild/testlogs/packages/db/bench_alpha/test.log"
echo "tps = 200" > "$TMP/bazel-out/k8-fastbuild/testlogs/packages/db/bench_beta/test.log"
echo "irrelevant" > "$TMP/bazel-out/k8-fastbuild/testlogs/packages/db/non_bench_target/test.log"
echo "tps = 300" > "$TMP/bazel-out/k8-fastbuild/testlogs/apps/api/bench_gamma/test.log"

OUTPUT="$TMP/output"
TESTLOGS_DIR="$TMP/bazel-out/k8-fastbuild/testlogs" \
    bash "$SCRIPT" "$OUTPUT"

# Three bench targets → three slugs. Non-bench target is excluded.
expected=(
    "packages-db-bench_alpha-test.log"
    "packages-db-bench_beta-test.log"
    "apps-api-bench_gamma-test.log"
)
for slug in "${expected[@]}"; do
    if [[ ! -f "$OUTPUT/$slug" ]]; then
        echo "FAIL: expected slug $slug not found in $OUTPUT" >&2
        ls "$OUTPUT" >&2
        exit 1
    fi
done

if [[ -f "$OUTPUT/packages-db-non_bench_target-test.log" ]]; then
    echo "FAIL: non-bench target was collected" >&2
    exit 1
fi

count=$(ls "$OUTPUT" | wc -l)
if [[ "$count" -ne 3 ]]; then
    echo "FAIL: expected 3 collected slugs, got $count" >&2
    ls "$OUTPUT" >&2
    exit 1
fi

echo "OK: collected ${count} bench slugs, excluded non-bench targets"

# ── EMPTY-fallback case ──────────────────────────────────────────────────────

EMPTY_TESTLOGS="$TMP/empty/testlogs"
mkdir -p "$EMPTY_TESTLOGS"
EMPTY_OUTPUT="$TMP/empty_output"
TESTLOGS_DIR="$EMPTY_TESTLOGS" bash "$SCRIPT" "$EMPTY_OUTPUT"

if [[ ! -f "$EMPTY_OUTPUT/EMPTY.txt" ]]; then
    echo "FAIL: expected EMPTY.txt fallback in $EMPTY_OUTPUT" >&2
    ls "$EMPTY_OUTPUT" >&2
    exit 1
fi
count=$(ls "$EMPTY_OUTPUT" | wc -l)
if [[ "$count" -ne 1 ]]; then
    echo "FAIL: empty case should produce exactly one file (EMPTY.txt), got $count" >&2
    exit 1
fi

echo "OK: empty-testlogs fallback writes EMPTY.txt"

# ── bazel-testlogs workspace-symlink fallback ────────────────────────────────
# Cover the local-dev fallback: TESTLOGS_DIR is the relative literal
# `bazel-testlogs` (workspace symlink). The find produces relative paths
# `bazel-testlogs/<pkg>/<target>/test.log`; the second sed
# (s|^bazel-testlogs/||) strips the prefix.

WORKSPACE="$TMP/workspace"
mkdir -p "$WORKSPACE/bazel-testlogs/packages/db/bench_delta"
echo "tps = 400" > "$WORKSPACE/bazel-testlogs/packages/db/bench_delta/test.log"
WS_OUTPUT="$WORKSPACE/output"
( cd "$WORKSPACE" && TESTLOGS_DIR="bazel-testlogs" bash "$SCRIPT" output )

if [[ ! -f "$WS_OUTPUT/packages-db-bench_delta-test.log" ]]; then
    echo "FAIL: workspace-symlink slug not produced" >&2
    ls "$WS_OUTPUT" >&2
    exit 1
fi

echo "OK: relative workspace-symlink form produces clean slug"
