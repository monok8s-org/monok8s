#!/usr/bin/env bash
# L2 smoke for the tenant-gcp Composition.
#
# Mirrors the tenant-namespace smoke shape, with two differences:
#   - target Composition name is `tenant-gcp`
#   - resources[].name list adds the GCP overlay entries on top of the
#     5 trunk resources

set -euo pipefail

KUBECTL="${KUBECTL:-kubectl}"

if [[ -z "${KUBECONFIG:-}" ]]; then
    echo "smoke: KUBECONFIG not set" >&2
    exit 1
fi

# 1. Composition admitted.
"$KUBECTL" get composition.apiextensions.crossplane.io tenant-gcp -o name

# 2. compositeTypeRef.kind is XTenant.
kind=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-gcp \
    -o jsonpath='{.spec.compositeTypeRef.kind}')
if [[ "$kind" != "XTenant" ]]; then
    echo "smoke: compositeTypeRef.kind=$kind, expected XTenant" >&2
    exit 1
fi

# 3. monok8s.io/provider=gcp label set so XRs can compositionSelector to it.
provider=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-gcp \
    -o jsonpath='{.metadata.labels.monok8s\.io/provider}')
if [[ "$provider" != "gcp" ]]; then
    echo "smoke: provider label is '$provider'; expected 'gcp'" >&2
    exit 1
fi

# 4. mode == Pipeline (Crossplane v2).
mode=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-gcp \
    -o jsonpath='{.spec.mode}')
if [[ "$mode" != "Pipeline" ]]; then
    echo "smoke: mode=$mode, expected Pipeline" >&2
    exit 1
fi

# 5. Resource list = 5 trunk + 2 GCP overlay = 7 entries.
resources=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-gcp \
    -o jsonpath='{.spec.pipeline[0].input.resources[*].name}')
expected="namespace postgres-cluster vault-policy vault-role db-creds gcp-service-account gcp-workload-identity-binding"
if [[ "$resources" != "$expected" ]]; then
    echo "smoke: resources='$resources'" >&2
    echo "smoke: expected='$expected'" >&2
    exit 1
fi

echo "smoke: ok"
