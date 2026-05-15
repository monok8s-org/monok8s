#!/usr/bin/env bash
# Asserts mask_bep_exit38.sh's exit-code translation matrix:
#   - bazel exit 0                       → mask exits 0
#   - bazel exit 38, log shows all-green → mask exits 0
#   - bazel exit 38, log shows partial   → mask exits 38
#   - bazel exit 38, log shows nothing   → mask exits 38
#   - bazel exit 1                       → mask exits 1
#   - bazel exit 38, multi-line w/ green → mask exits 0
#   - missing arguments                  → mask exits 64

set -uo pipefail

SCRIPT_REL="${1:?missing path to mask_bep_exit38.sh}"
SCRIPT="$(readlink -f "$SCRIPT_REL")"
[[ -x "$SCRIPT" ]] || chmod +x "$SCRIPT"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ── Helper: write a stub bazel-test command that emits a canned log
# ── then exits with the chosen code. Each fixture is its own bash
# ── script so $@ forwarding inside mask_bep_exit38.sh exercises the
# ── real `"$@"` dispatch path.

make_stub() {
    local path="$1"
    local exit_code="$2"
    local log_body="$3"
    cat > "$path" <<EOF
#!/usr/bin/env bash
cat <<'BAZEL_OUT'
${log_body}
BAZEL_OUT
exit ${exit_code}
EOF
    chmod +x "$path"
}

# ── Case 1: bazel exit 0 → mask exits 0 ──────────────────────────────────────
STUB_0="$TMP/stub_exit0.sh"
make_stub "$STUB_0" 0 "Executed 5 out of 5 tests: 5 tests pass."
set +e
bash "$SCRIPT" "$STUB_0" >/dev/null 2>&1
got=$?
set -e
if [[ "$got" -ne 0 ]]; then
    echo "FAIL case-1 (bazel exit 0 → mask should exit 0): got $got" >&2
    exit 1
fi
echo "OK case-1: bazel exit 0 → mask exits 0"

# ── Case 2: bazel exit 38 + all-green summary → mask exits 0 ─────────────────
STUB_38_GREEN="$TMP/stub_exit38_green.sh"
make_stub "$STUB_38_GREEN" 38 "
INFO: Build completed successfully, 100 total actions
//apps/api:principals_unit_test     PASSED in 4.4s
Executed 105 out of 105 tests: 105 tests pass.
WARNING: Uploading BEP referenced local file: UNAUTHENTICATED: missing API key
ERROR: The Build Event Protocol upload failed
"
set +e
bash "$SCRIPT" "$STUB_38_GREEN" >/dev/null 2>&1
got=$?
set -e
if [[ "$got" -ne 0 ]]; then
    echo "FAIL case-2 (exit 38 + green → mask should exit 0): got $got" >&2
    exit 1
fi
echo "OK case-2: exit 38 with all-green summary → mask exits 0"

# ── Case 3: bazel exit 38 + partial-pass summary → mask exits 38 ─────────────
# Bazel writes a different terminal line when not all tests pass; our
# tight predicate must NOT match it. Use the canonical "out of N tests"
# shape but with a non-passing tail.
STUB_38_PARTIAL="$TMP/stub_exit38_partial.sh"
make_stub "$STUB_38_PARTIAL" 38 "
//apps/api:principals_unit_test     FAILED in 2.2s
Executed 105 out of 105 tests: 104 tests pass and 1 fails locally.
"
set +e
bash "$SCRIPT" "$STUB_38_PARTIAL" >/dev/null 2>&1
got=$?
set -e
if [[ "$got" -ne 38 ]]; then
    echo "FAIL case-3 (exit 38 + partial → mask should exit 38): got $got" >&2
    exit 1
fi
echo "OK case-3: exit 38 with partial-pass summary → mask propagates 38"

# ── Case 4: bazel exit 38 + no summary line → mask exits 38 ──────────────────
STUB_38_NOLOG="$TMP/stub_exit38_nolog.sh"
make_stub "$STUB_38_NOLOG" 38 "
ERROR: Build did NOT complete successfully
"
set +e
bash "$SCRIPT" "$STUB_38_NOLOG" >/dev/null 2>&1
got=$?
set -e
if [[ "$got" -ne 38 ]]; then
    echo "FAIL case-4 (exit 38 + no summary → mask should exit 38): got $got" >&2
    exit 1
fi
echo "OK case-4: exit 38 with no all-green summary → mask propagates 38"

# ── Case 5: bazel exit 1 (real test failure) → mask exits 1 ──────────────────
STUB_1="$TMP/stub_exit1.sh"
make_stub "$STUB_1" 1 "
//apps/api:principals_unit_test     FAILED in 2.2s
Executed 105 out of 105 tests: 104 tests pass and 1 fails locally.
"
set +e
bash "$SCRIPT" "$STUB_1" >/dev/null 2>&1
got=$?
set -e
if [[ "$got" -ne 1 ]]; then
    echo "FAIL case-5 (bazel exit 1 → mask should exit 1): got $got" >&2
    exit 1
fi
echo "OK case-5: bazel exit 1 (real failure) → mask propagates 1"

# ── Case 6: bazel exit 38 + multi-line log w/ green at end → mask exits 0 ────
# Defensive: make sure the predicate matches the green line wherever
# it falls in the log, not just first or last.
STUB_38_MID="$TMP/stub_exit38_mid.sh"
make_stub "$STUB_38_MID" 38 "
INFO: Executing 100 test targets
Executed 100 out of 100 tests: 100 tests pass.
WARNING: BEP upload retry 1
WARNING: BEP upload retry 2
ERROR: The Build Event Protocol upload failed
"
set +e
bash "$SCRIPT" "$STUB_38_MID" >/dev/null 2>&1
got=$?
set -e
if [[ "$got" -ne 0 ]]; then
    echo "FAIL case-6 (exit 38 + mid-log green → mask should exit 0): got $got" >&2
    exit 1
fi
echo "OK case-6: exit 38 with mid-log green summary → mask exits 0"

# ── Case 7: missing arguments → mask exits 64 (EX_USAGE) ─────────────────────
set +e
bash "$SCRIPT" >/dev/null 2>&1
got=$?
set -e
if [[ "$got" -ne 64 ]]; then
    echo "FAIL case-7 (no args → mask should exit 64): got $got" >&2
    exit 1
fi
echo "OK case-7: no arguments → mask exits 64 (EX_USAGE)"

echo "ALL OK: 7 cases passed"
