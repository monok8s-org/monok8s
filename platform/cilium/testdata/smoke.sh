#!/usr/bin/env bash
# Cilium's Helm chart install ships the agent + operator + envoy-proxy
# components. CRDs (ciliumnodes / ciliumnetworkpolicies / etc.) are
# registered by the operator at runtime, not bundled in this manifest;
# we only assert install components.
set -euo pipefail
bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/cilium/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
must() { grep -qE -- "$1" "$bootstrap" || { echo "smoke: missing $2 ($1)"; exit 1; }; }
must '^kind: DaemonSet$'         'cilium-agent DaemonSet'
must '^kind: Deployment$'        'cilium-operator Deployment'
must '^  name: cilium$'          'cilium agent resource'
must '^  name: cilium-operator$' 'cilium-operator resource'
must 'name: cilium-config$'      'cilium-config ConfigMap'
echo "smoke: ok"
