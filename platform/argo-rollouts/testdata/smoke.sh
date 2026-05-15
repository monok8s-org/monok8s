#!/usr/bin/env bash
set -euo pipefail
bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/argo-rollouts/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
must() { grep -qE "$1" "$bootstrap" || { echo "smoke: missing $2 ($1)"; exit 1; }; }
must '^  name: rollouts\.argoproj\.io$'           'CRD rollouts'
must '^  name: analysisruns\.argoproj\.io$'       'CRD analysisruns'
must '^  name: experiments\.argoproj\.io$'        'CRD experiments'
must '^kind: Deployment$'                         'argo-rollouts controller Deployment'
must '^  name: argo-rollouts$'                    'argo-rollouts resource'
echo "smoke: ok"
