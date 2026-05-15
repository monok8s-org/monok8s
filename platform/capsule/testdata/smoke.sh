#!/usr/bin/env bash
# Validates the vendored Capsule manifest's shape + the default-tenant
# template's structural shape. Cheap & deterministic — no cluster.

set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/capsule/bootstrap.yaml' 2>/dev/null | head -1)
template=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*templates/default-tenant.yaml' 2>/dev/null | head -1)

[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
[[ -f "$template" ]]  || { echo "smoke: default-tenant.yaml not found"; exit 1; }

# Bootstrap: Capsule's Tenant + CapsuleConfiguration CRDs + the operator Deployment.
must() {
    local pattern="$1" file="$2" label="$3"
    grep -qE "$pattern" "$file" \
        || { echo "smoke: $file missing $label (pattern: $pattern)"; exit 1; }
}

must '^  name: tenants\.capsule\.clastix\.io$'              "$bootstrap" 'CRD tenants.capsule.clastix.io'
must '^  name: capsuleconfigurations\.capsule\.clastix\.io$' "$bootstrap" 'CRD capsuleconfigurations.capsule.clastix.io'
must '^kind: Deployment$'                                    "$bootstrap" 'at least one Deployment'
must '^  name: capsule-controller-manager$'                  "$bootstrap" 'capsule-controller-manager'
must '^kind: MutatingWebhookConfiguration$'                  "$bootstrap" 'MutatingWebhookConfiguration'

# Default tenant template per AC#3: ResourceQuota + LimitRange + NetworkPolicy.
must 'kind: Tenant$'                  "$template" 'kind: Tenant'
must 'apiVersion: capsule\.clastix\.' "$template" 'capsule.clastix apiVersion'
must '^\s*resourceQuotas:'            "$template" 'resourceQuotas section'
must '^\s*limitRanges:'               "$template" 'limitRanges section'
must '^\s*networkPolicies:'           "$template" 'networkPolicies section'
must 'requests\.cpu:'                 "$template" 'cpu request quota'
must 'requests\.memory:'              "$template" 'memory request quota'

echo "smoke: ok"
