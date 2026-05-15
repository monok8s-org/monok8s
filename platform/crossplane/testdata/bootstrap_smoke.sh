#!/usr/bin/env bash
# Crossplane operator install shape smoke (#159 / #145 prereq).
#
# Pure grep-based, no cluster, no Docker. Mirrors
# platform/argo-workflows/testdata/bootstrap_smoke.sh.
#
# Asserts the helm-rendered bootstrap.yaml carries:
#   - The two ServiceAccounts (crossplane, rbac-manager).
#   - Both operator Deployments (crossplane, crossplane-rbac-manager).
#   - The cluster-admin ClusterRole (crossplane) + its binding.
#   - The webhook Service (crossplane-webhooks).
#
# Crossplane v2's chart does NOT bundle CRDs — the controller installs
# them at startup. The L4 e2e test (#145) waits for them after the
# controller comes up. Don't assert CRD presence here.

set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/crossplane/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }

must() {
    grep -qE -- "$1" "$bootstrap" || {
        echo "smoke: missing $2 (regex: $1)" >&2
        exit 1
    }
}

# ServiceAccounts.
must '^  name: rbac-manager$'                      'ServiceAccount rbac-manager'
must '^  name: crossplane$'                        'ServiceAccount/Deployment crossplane'

# Deployments.
must '^kind: Deployment$'                          'Deployment kind'
must '^  name: crossplane-rbac-manager$'           'Deployment crossplane-rbac-manager'

# ClusterRoles (cluster-admin scope needed for self-installing CRDs).
must '^kind: ClusterRole$'                         'ClusterRole kind'
must '^  name: crossplane-rbac-manager$'           'ClusterRole crossplane-rbac-manager'

# ClusterRoleBindings.
must '^kind: ClusterRoleBinding$'                  'ClusterRoleBinding kind'

# Webhook Service (admission webhook target).
must '^kind: Service$'                             'Service kind'
must '^  name: crossplane-webhooks$'               'Service crossplane-webhooks'

# Namespace pin — every resource must target crossplane-system.
must '^  namespace: crossplane-system$'            'namespace crossplane-system'

echo "smoke: ok"
