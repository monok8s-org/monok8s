#!/usr/bin/env bash
# Asserts platform_cloud_neutral.sh's leak-detection semantics:
#   1. Empty platform/ → exit 0
#   2. Leak in non-overlay path → exit 1
#   3. Leak inside allowed overlay path → exit 0
#   4. Multiple leaks → exit 1 with all leaks reported

set -uo pipefail

SCRIPT_REL="${1:?missing path to platform_cloud_neutral.sh}"
SCRIPT="$(readlink -f "$SCRIPT_REL")"
[[ -x "$SCRIPT" ]] || chmod +x "$SCRIPT"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ── Case 1: empty platform/ → exit 0 ─────────────────────────────────────────
mkdir -p "$TMP/case1/platform"
(cd "$TMP/case1" && bash "$SCRIPT" platform > /dev/null 2>&1)
got=$?
if [[ "$got" -ne 0 ]]; then
  echo "FAIL case-1 (empty platform → exit 0): got $got" >&2
  exit 1
fi
echo "OK case-1: empty platform tree → exit 0"

# ── Case 2: leak in non-overlay path → exit 1 ────────────────────────────────
mkdir -p "$TMP/case2/platform/some-component"
cat > "$TMP/case2/platform/some-component/bootstrap.yaml" <<'EOF'
apiVersion: sqs.aws.upbound.io/v1beta1
kind: Queue
EOF
set +e
(cd "$TMP/case2" && bash "$SCRIPT" platform > /dev/null 2>&1)
got=$?
set -e
if [[ "$got" -ne 1 ]]; then
  echo "FAIL case-2 (leak in core path → exit 1): got $got" >&2
  exit 1
fi
echo "OK case-2: leak in non-overlay path → exit 1"

# ── Case 3: leak inside per-cloud overlay path → exit 0 ──────────────────────
# Matches the existing platform/security-findings/aws/ shape.
mkdir -p "$TMP/case3/platform/some-component/aws"
cat > "$TMP/case3/platform/some-component/aws/resources.yaml" <<'EOF'
apiVersion: sqs.aws.upbound.io/v1beta1
kind: Queue
EOF
(cd "$TMP/case3" && bash "$SCRIPT" platform > /dev/null 2>&1)
got=$?
if [[ "$got" -ne 0 ]]; then
  echo "FAIL case-3 (leak in allowed overlay → exit 0): got $got" >&2
  exit 1
fi
echo "OK case-3: leak inside per-cloud subdir → exit 0"

# ── Case 4: leak inside overlays/<cloud>/ shape → exit 0 ─────────────────────
mkdir -p "$TMP/case4/platform/harbor/overlays/gcp"
cat > "$TMP/case4/platform/harbor/overlays/gcp/values.yaml" <<'EOF'
storage:
  bucket: my-bucket
  endpoint: storage.googleapis.com
EOF
(cd "$TMP/case4" && bash "$SCRIPT" platform > /dev/null 2>&1)
got=$?
if [[ "$got" -ne 0 ]]; then
  echo "FAIL case-4 (overlay path → exit 0): got $got" >&2
  exit 1
fi
echo "OK case-4: leak inside overlays/<cloud>/ → exit 0"

# ── Case 5: multiple leaks reported (all of them) ────────────────────────────
mkdir -p "$TMP/case5/platform/a" "$TMP/case5/platform/b"
cat > "$TMP/case5/platform/a/x.yaml" <<'EOF'
apiVersion: sqs.aws.upbound.io/v1beta1
EOF
cat > "$TMP/case5/platform/b/y.yaml" <<'EOF'
host: compute.googleapis.com
EOF
set +e
out=$( (cd "$TMP/case5" && bash "$SCRIPT" platform 2>&1) )
got=$?
set -e
if [[ "$got" -ne 1 ]]; then
  echo "FAIL case-5 (multiple leaks → exit 1): got $got" >&2
  exit 1
fi
if ! echo "$out" | grep -q "platform/a/x.yaml"; then
  echo "FAIL case-5 (missing a leak): $out" >&2
  exit 1
fi
if ! echo "$out" | grep -q "platform/b/y.yaml"; then
  echo "FAIL case-5 (missing b leak): $out" >&2
  exit 1
fi
echo "OK case-5: multiple leaks all reported"

# ── Case 6: scan against the real monorepo's platform/ tree ──────────────────
# This catches real leaks the scanner would surface against current
# `main`. Run with the live `platform` arg via the test's runfiles.
# The test target sets MONOK8S_REAL_PLATFORM to skip this when not
# desired (e.g. in CI on a branch that intentionally adds a leak).
if [[ -n "${MONOK8S_REAL_PLATFORM:-}" ]] && [[ -d "$MONOK8S_REAL_PLATFORM" ]]; then
  bash "$SCRIPT" "$MONOK8S_REAL_PLATFORM" > /dev/null 2>&1
  got=$?
  if [[ "$got" -ne 0 ]]; then
    echo "FAIL case-6 (real platform/ tree has leaks): re-run \`bash $SCRIPT platform\` to see them" >&2
    exit 1
  fi
  echo "OK case-6: real platform/ tree is leak-free"
fi

echo "ALL OK"
