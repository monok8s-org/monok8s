#!/usr/bin/env bash
# Validates the vendored Vault dev-mode manifest's shape: a StatefulSet
# (vault), 2 Services (vault, vault-internal), ServiceAccount, and the
# ClusterRoleBinding for kube-auth. Cheap & deterministic.

set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/vault/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }

must() {
    local pattern="$1" label="$2"
    grep -qE "$pattern" "$bootstrap" \
        || { echo "smoke: missing $label (pattern: $pattern)"; exit 1; }
}

must '^kind: StatefulSet$'         'StatefulSet (vault server)'
must '^  name: vault$'             'vault resource'
must '^kind: ServiceAccount$'      'ServiceAccount'
must '^kind: ClusterRoleBinding$'  'ClusterRoleBinding (kube-auth)'
must '^kind: Service$'             'Service'
must 'name: vault-internal'        'vault-internal Service'

echo "smoke: ok"
