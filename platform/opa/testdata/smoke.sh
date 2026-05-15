#!/usr/bin/env bash
# Validates the vendored Gatekeeper manifest + the require-tenant-label
# ConstraintTemplate + Constraint files. Cheap & deterministic — no
# cluster. Full Gatekeeper-mediated rejection lives in L4 #37; the
# rejection LOGIC is unit-tested at //platform/opa/policies:require_tenant_label_test.

set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/opa/bootstrap.yaml' 2>/dev/null | head -1)
template=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*constraints/require-tenant-label-template.yaml' 2>/dev/null | head -1)
constraint=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*constraints/require-tenant-label-constraint.yaml' 2>/dev/null | head -1)

[[ -f "$bootstrap"  ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
[[ -f "$template"   ]] || { echo "smoke: ConstraintTemplate not found"; exit 1; }
[[ -f "$constraint" ]] || { echo "smoke: Constraint not found"; exit 1; }

must() {
    local pattern="$1" file="$2" label="$3"
    grep -qE "$pattern" "$file" \
        || { echo "smoke: $file missing $label (pattern: $pattern)"; exit 1; }
}

# Bootstrap: Gatekeeper's CRDs + admission webhook + controller.
must '^  name: constrainttemplates\.templates\.gatekeeper\.sh$' "$bootstrap" 'CRD constrainttemplates'
must '^  name: configs\.config\.gatekeeper\.sh$'                 "$bootstrap" 'CRD configs'
must '^  name: gatekeeper-controller-manager$'                   "$bootstrap" 'controller Deployment'
must '^kind: ValidatingWebhookConfiguration$'                    "$bootstrap" 'ValidatingWebhookConfiguration'
must '^kind: MutatingWebhookConfiguration$'                      "$bootstrap" 'MutatingWebhookConfiguration'

# ConstraintTemplate: kind k8srequiredtenantlabel + rego with violation rule.
must 'kind: ConstraintTemplate$'             "$template" 'kind: ConstraintTemplate'
must 'name: k8srequiredtenantlabel$'         "$template" 'CRD name: K8sRequiredTenantLabel'
must 'kind: K8sRequiredTenantLabel$'         "$template" 'spec.crd.spec.names.kind'
must 'admission\.k8s\.gatekeeper\.sh'        "$template" 'admission target'
must 'monok8s\.io/tenant'                    "$template" 'tenant label reference in rego'
must 'violation\['                           "$template" 'violation rule'

# Constraint: refers to K8sRequiredTenantLabel + targets Namespace + denies.
must 'kind: K8sRequiredTenantLabel$'  "$constraint" 'instance kind'
must 'enforcementAction: deny$'       "$constraint" 'enforcementAction: deny'
must 'kinds: \["Namespace"\]'         "$constraint" 'targets Namespace'

echo "smoke: ok"
