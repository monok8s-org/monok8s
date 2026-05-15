#!/usr/bin/env bash
# Structural shape smoke for platform/argo-workflows/templates/
# manifests. Mirrors the platform/cloudnativepg/testdata/smoke.sh
# pattern — pure grep-based shape check, no cluster required.
#
# Validates each WorkflowTemplate manifest for:
#   - WorkflowTemplate kind + canonical metadata.name
#   - entrypoint + tenantId parameter declaration
#   - container step with the right command shape
#   - onExit publish-status step targeting the canonical NATS subject
#     pattern (workflow.tenant.<tid>.<step-name>)
#   - natsio/nats-box image for the publish step
#
# Templates covered:
#   - apply-tenant-migrations.yaml (#86)
#   - mint-tenant-vault-key.yaml  (#83)
#
# Live operator submission needs the Argo Workflows controller (filed
# as a separate operator-install Issue per the bootstrap-split shape;
# consumed by Tier-2 #84, tracked at #120). This smoke is the
# manifest-only validation.

set -euo pipefail

# Runfiles-aware resolver for a manifest under
# platform/argo-workflows/templates/.
resolve_manifest() {
    local leaf="$1"
    local root candidate
    for root in "${RUNFILES_DIR:-}" "${TEST_SRCDIR:-}" "$PWD"; do
        [[ -z "$root" ]] && continue
        candidate=$(find "$root" -path "*platform/argo-workflows/templates/${leaf}" 2>/dev/null | head -1)
        if [[ -n "$candidate" && -f "$candidate" ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

must() {
    local manifest="$1" regex="$2" label="$3"
    grep -qE -- "$regex" "$manifest" || {
        echo "smoke: missing $label in $(basename "$manifest") (regex: $regex)" >&2
        exit 1
    }
}

# ── apply-tenant-migrations.yaml (#86) ───────────────────────────────────
manifest=$(resolve_manifest 'apply-tenant-migrations.yaml') || {
    echo "smoke: apply-tenant-migrations.yaml not found" >&2
    exit 1
}

must "$manifest" '^kind: WorkflowTemplate$'                       'WorkflowTemplate kind'
must "$manifest" '^apiVersion: argoproj.io/v1alpha1$'             'argoproj.io/v1alpha1 apiVersion'
must "$manifest" '^  name: apply-tenant-migrations$'              'metadata.name = apply-tenant-migrations'
must "$manifest" '^  entrypoint: apply$'                          'spec.entrypoint = apply'
must "$manifest" '- name: tenantId$'                              'tenantId parameter declaration'
must "$manifest" '^    - name: apply$'                            'apply template'
must "$manifest" 'migrate-apply'                                  'migrate-apply binary reference'
must "$manifest" '\{\{inputs\.parameters\.tenantId\}\}'           'tenantId input interpolation'
must "$manifest" '^      onExit: publish-status$'                 'onExit handler wiring'
must "$manifest" '^    - name: publish-status$'                   'publish-status template'
must "$manifest" 'natsio/nats-box'                                'nats-box container image'
must "$manifest" 'workflow\.tenant\..*\.migrations'               'NATS subject pattern (migrations)'

# ── mint-tenant-vault-key.yaml (#83) ─────────────────────────────────────
manifest=$(resolve_manifest 'mint-tenant-vault-key.yaml') || {
    echo "smoke: mint-tenant-vault-key.yaml not found" >&2
    exit 1
}

must "$manifest" '^kind: WorkflowTemplate$'                       'WorkflowTemplate kind'
must "$manifest" '^apiVersion: argoproj.io/v1alpha1$'             'argoproj.io/v1alpha1 apiVersion'
must "$manifest" '^  name: mint-tenant-vault-key$'                'metadata.name = mint-tenant-vault-key'
must "$manifest" '^  entrypoint: mint$'                           'spec.entrypoint = mint'
must "$manifest" '- name: tenantId$'                              'tenantId parameter declaration'
must "$manifest" '^    - name: mint$'                             'mint template'
must "$manifest" 'transit/keys/tenant-'                           'transit key path shape'
must "$manifest" 'type=aes256-gcm96'                              'aes256-gcm96 key type'
must "$manifest" 'convergent_encryption=true'                     'convergent_encryption flag'
must "$manifest" 'derived=true'                                   'derived flag'
must "$manifest" 'hashicorp/vault'                                'hashicorp/vault container image'
must "$manifest" '\{\{inputs\.parameters\.tenantId\}\}'           'tenantId input interpolation'
must "$manifest" '^      onExit: publish-status$'                 'onExit handler wiring'
must "$manifest" '^    - name: publish-status$'                   'publish-status template'
must "$manifest" 'natsio/nats-box'                                'nats-box container image'
must "$manifest" 'workflow\.tenant\..*\.mint-vault-key'           'NATS subject pattern (mint-vault-key)'

echo "smoke: ok"
