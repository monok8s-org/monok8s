#!/usr/bin/env bash
# Validates ESO bootstrap shape + the vault-backend ClusterSecretStore
# wiring. Static checks only — runtime ESO reconciliation lives in L4.

set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/external-secrets/bootstrap.yaml' 2>/dev/null | head -1)
store=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/external-secrets/cluster-secret-store.yaml' 2>/dev/null | head -1)

[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
[[ -f "$store"     ]] || { echo "smoke: cluster-secret-store.yaml not found"; exit 1; }

must() {
    local pattern="$1" file="$2" label="$3"
    grep -qE "$pattern" "$file" \
        || { echo "smoke: $file missing $label (pattern: $pattern)"; exit 1; }
}

# ESO bootstrap: CRDs + 3 Deployments + admission webhook.
must '^  name: externalsecrets\.external-secrets\.io$'   "$bootstrap" 'CRD externalsecrets'
must '^  name: clustersecretstores\.external-secrets\.io$' "$bootstrap" 'CRD clustersecretstores'
must '^  name: secretstores\.external-secrets\.io$'      "$bootstrap" 'CRD secretstores'
must '^kind: Deployment$'                                "$bootstrap" 'at least one Deployment'
must '^  name: external-secrets$'                        "$bootstrap" 'external-secrets controller'
must '^  name: external-secrets-webhook$'                "$bootstrap" 'webhook Deployment'
must '^  name: external-secrets-cert-controller$'        "$bootstrap" 'cert-controller Deployment'
must '^kind: ValidatingWebhookConfiguration$'            "$bootstrap" 'ValidatingWebhookConfiguration'

# ClusterSecretStore: vault-backend pointing at in-cluster Vault.
must 'kind: ClusterSecretStore$'           "$store" 'kind: ClusterSecretStore'
must '^  name: vault-backend$'             "$store" 'name: vault-backend'
must 'vault\.vault\.svc'                   "$store" 'in-cluster Vault DNS'
must 'auth:'                               "$store" 'auth section'
must 'kubernetes:'                         "$store" 'kubernetes auth method'

echo "smoke: ok"
