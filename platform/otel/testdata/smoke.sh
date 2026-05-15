#!/usr/bin/env bash
# otel platform install shape smoke (#25).
set -euo pipefail
bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/otel/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
must() { grep -qE -- "$1" "$bootstrap" || { echo "smoke: missing $2 ($1)"; exit 1; }; }
must '^kind: (Deployment|StatefulSet)$'  'workload'
must '^kind: Service$'                    'Service'
must '^kind: ConfigMap$'                  'ConfigMap'
echo "smoke: ok (otel)"
