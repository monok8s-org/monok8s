#!/usr/bin/env bash
# Walk the bazel test-logs tree for `bench_*` target test.log files
# and copy them into a flat output dir with a human-readable slug
# encoding the package path + target name.
#
# Resolution order for the testlogs root:
#   1. $TESTLOGS_DIR env var (used by the unit test against a fixture)
#   2. `bazel info bazel-testlogs` (canonical path, works under
#      `--config=remote` where the workspace symlink isn't always
#      created — e.g. when `bazel test` exits non-zero from BEP upload
#      failure post-test-run, which this project hits without a
#      BuildBuddy API key in GHA)
#   3. `bazel-testlogs` workspace symlink (fallback for local dev)
#
# Output is written to the dir named by $1 (default `bench-results`).
# If no bench logs match, the script writes a single `EMPTY.txt` so
# downstream artifact upload always has something to upload.

set -euo pipefail

OUTPUT_DIR="${1:-bench-results}"
mkdir -p "$OUTPUT_DIR"

if [[ -z "${TESTLOGS_DIR:-}" ]]; then
    TESTLOGS_DIR=$(bazel info bazel-testlogs 2>/dev/null || true)
fi
if [[ -z "$TESTLOGS_DIR" || ! -d "$TESTLOGS_DIR" ]]; then
    TESTLOGS_DIR=bazel-testlogs
fi

find "$TESTLOGS_DIR" -path '*/bench_*/test.log' -print0 2>/dev/null | \
    while IFS= read -r -d '' f; do
        # First sed handles the absolute path from `bazel info`
        # (strips `.*/testlogs/`); second handles the fallback
        # workspace-relative `bazel-testlogs/...` form.
        slug=$(echo "$f" \
            | sed -e 's|.*/testlogs/||' \
                  -e 's|^bazel-testlogs/||' \
                  -e 's|/|-|g')
        cp "$f" "$OUTPUT_DIR/$slug"
    done

if [[ -z "$(ls "$OUTPUT_DIR")" ]]; then
    echo "no bench targets matched //... with --test_tag_filters=bench" \
        > "$OUTPUT_DIR/EMPTY.txt"
fi
