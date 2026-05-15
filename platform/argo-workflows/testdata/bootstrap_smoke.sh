#!/usr/bin/env bash
# Argo Workflows operator install shape smoke (#120). Mirrors
# platform/cloudnativepg/testdata/smoke.sh — pure grep-based,
# no cluster, no Docker.
#
# Asserts the vendored bootstrap.yaml contains:
#   - The four AC-required CRDs (workflows, workflowtemplates,
#     cronworkflows, clusterworkflowtemplates — all under
#     `argoproj.io`).
#   - Both operator Deployments (workflow-controller, argo-server).
#
# The four additional CRDs in v4.x (workflowtaskresults, workflowtasksets,
# workflowartifactgctasks, workfloweventbindings) are not asserted —
# they're internal to Argo Workflows and not gating the bootstrap-split
# contract; CRDs can be added upstream without breaking #86/#83's
# WorkflowTemplate manifests.

set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/argo-workflows/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }

must() {
    grep -qE -- "$1" "$bootstrap" || {
        echo "smoke: missing $2 (regex: $1)" >&2
        exit 1
    }
}

# Four AC-required CRDs.
must '^  name: workflows\.argoproj\.io$'              'CRD workflows.argoproj.io'
must '^  name: workflowtemplates\.argoproj\.io$'      'CRD workflowtemplates.argoproj.io'
must '^  name: cronworkflows\.argoproj\.io$'          'CRD cronworkflows.argoproj.io'
must '^  name: clusterworkflowtemplates\.argoproj\.io$' 'CRD clusterworkflowtemplates.argoproj.io'

# Operator Deployments.
must '^kind: Deployment$'                             'operator Deployment kind'
must '^  name: workflow-controller$'                  'workflow-controller Deployment'
must '^  name: argo-server$'                          'argo-server Deployment'

# Confirm install lands in the expected namespace.
must '^  namespace: argo$'                            'namespace: argo'

echo "smoke: ok"
