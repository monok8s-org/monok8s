#!/usr/bin/env bash
# Wrap a `bazel test //...` invocation in .github/workflows/pr-checks.yml
# to mask exit code 38 from the BuildBuddy Build Event Protocol upload
# step when the underlying test run actually passed.
#
# Why this exists: this repo doesn't carry a BUILDBUDDY_API_KEY secret
# (project decision — no paid BuildBuddy). The workflow still forwards
# the empty value as `--bes_header=x-buildbuddy-api-key=`, so the BEP
# upload step ALWAYS fails with `UNAUTHENTICATED: missing API key` and
# returns exit code 38 — after every test has already passed. The
# bench.yml workflow already routes around the same shape via its
# `if: always()` regression-check step; pr-checks.yml has no follow-on
# step so the exit-38 kills the workflow even though the test surface
# is green.
#
# Contract:
#   $1+    — the bazel test command + flags, run as-is and captured.
#   exit 0 — bazel exited 0, OR exited 38 AND log contains
#            "Executed N out of N tests: N tests pass." (the canonical
#            all-green summary line Bazel writes to stdout). Any other
#            exit is forwarded unchanged.
#
# The "tests pass" predicate is intentionally tight — partial-pass
# summaries ("Executed 102 out of 103 tests: 1 fails locally") do NOT
# match, so a real failure still propagates through the mask.

set -uo pipefail

if [[ "$#" -lt 1 ]]; then
    echo "usage: mask_bep_exit38.sh <bazel test command + flags>" >&2
    exit 64  # EX_USAGE
fi

# Capture stdout + stderr in a temp log AND tee them to the workflow
# console so the user sees the test progress in real time.
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT

set +e
"$@" 2>&1 | tee "$LOG"
EXIT_CODE=${PIPESTATUS[0]}
set -e

if [[ "$EXIT_CODE" -eq 0 ]]; then
    exit 0
fi

# Tight predicate per the contract above — match the exact "all green"
# summary line. `grep -E` so the digits are clear; `-q` keeps the
# output clean.
if [[ "$EXIT_CODE" -eq 38 ]] && \
        grep -qE 'Executed [0-9]+ out of [0-9]+ tests: [0-9]+ tests pass\.' "$LOG"; then
    echo "::notice::Masking bazel exit 38 — all tests passed; BEP upload failure ignored (no BUILDBUDDY_API_KEY on repo)"
    exit 0
fi

exit "$EXIT_CODE"
