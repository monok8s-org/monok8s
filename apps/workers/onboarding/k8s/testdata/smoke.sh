#!/usr/bin/env bash
# Onboarding worker Deployment shape smoke (#158 / #145 prereq).
#
# Pure grep-based, no cluster, no Docker. Mirrors
# platform/monok8s-bootstrap/testdata/smoke.sh.
#
# Asserts the base manifest set carries:
#   - Deployment monok8s-worker-onboarding pointing at the Harbor image
#   - Env vars the worker reads at runtime (TEMPORAL_ADDRESS,
#     TEMPORAL_NAMESPACE, NATS_URL)
#   - ServiceAccount + ClusterRole + ClusterRoleBinding shape
#   - The cluster-scoped XR resources (xtenants, xtenantdatabases)
#     and namespace-scoped Argo Workflow rules

set -euo pipefail

base="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}/_main/apps/workers/onboarding/k8s/base"
[[ -d "$base" ]] || { echo "smoke: base dir not found at $base"; exit 1; }

must() {
    local pattern="$1" desc="$2" file="$3"
    grep -qE -- "$pattern" "$file" || {
        echo "smoke: missing $desc in $file (regex: $pattern)" >&2
        exit 1
    }
}

# Deployment shape.
must '^kind: Deployment$'                      'Deployment kind'      "$base/deployment.yaml"
must '^  name: monok8s-worker-onboarding$'     'deployment name'      "$base/deployment.yaml"
must 'harbor\.monok8s\.internal/monok8s/onboarding:latest' 'image' "$base/deployment.yaml"
must 'serviceAccountName: monok8s-worker-onboarding' 'SA name'        "$base/deployment.yaml"

# Env vars the worker actually reads (matched to run.go + activities files).
must 'TEMPORAL_ADDRESS'                        'TEMPORAL_ADDRESS env' "$base/deployment.yaml"
must 'TEMPORAL_NAMESPACE'                      'TEMPORAL_NAMESPACE'   "$base/deployment.yaml"
must 'NATS_URL'                                'NATS_URL env'         "$base/deployment.yaml"

# RBAC shape.
must '^kind: ServiceAccount$'                  'ServiceAccount kind'  "$base/rbac.yaml"
must '^kind: ClusterRole$'                     'ClusterRole kind'     "$base/rbac.yaml"
must '^kind: ClusterRoleBinding$'              'ClusterRoleBinding'   "$base/rbac.yaml"
must 'xtenants'                                'xtenants rule'        "$base/rbac.yaml"
must 'xtenantdatabases'                        'xtenantdatabases'     "$base/rbac.yaml"
must 'workflows'                               'argo workflows rule'  "$base/rbac.yaml"

echo "smoke: ok"
