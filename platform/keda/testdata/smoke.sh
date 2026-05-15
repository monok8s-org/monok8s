#!/usr/bin/env bash
set -euo pipefail
bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/keda/bootstrap.yaml' 2>/dev/null | head -1)
scaled=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/keda/workers-scaledobject.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
[[ -f "$scaled"    ]] || { echo "smoke: workers-scaledobject.yaml not found"; exit 1; }

# `--` stops grep flag parsing so patterns starting with `-` (the YAML
# list-item lines we want to match in the ScaledObject) don't get
# interpreted as flags.
must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# KEDA bootstrap: 3 Deployments + ScaledObject CRDs.
must "$bootstrap" '^  name: scaledobjects\.keda\.sh$'      'CRD scaledobjects'
must "$bootstrap" '^  name: scaledjobs\.keda\.sh$'         'CRD scaledjobs'
must "$bootstrap" '^  name: keda-operator$'                'keda-operator Deployment'
must "$bootstrap" '^  name: keda-operator-metrics-apiserver$' 'metrics apiserver'
must "$bootstrap" '^  name: keda-admission-webhooks$'      'admission webhooks'

# ScaledObject: Temporal trigger, min/max counts per AC#3.
must "$scaled" '^kind: ScaledObject$'              'kind: ScaledObject'
must "$scaled" 'minReplicaCount: 1$'               'minReplicaCount=1 (apps/workers/CLAUDE.md)'
must "$scaled" 'maxReplicaCount: 10$'              'maxReplicaCount=10 (AC#3)'
must "$scaled" '^    - type: temporal$'            'temporal trigger type'
must "$scaled" 'targetQueueSize: "5"$'             'targetQueueSize documented'

echo "smoke: ok"
