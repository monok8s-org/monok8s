#!/usr/bin/env bash
# L2 smoke for the tenant-capsule Composition (#81).
#
# Runs under //tools/bazel:itest_suite with KUBECONFIG pointing at a
# kube-apiserver+etcd envtest. The Crossplane meta-CRDs + XTenant XRD +
# Capsule Tenant CRD + Cilium CiliumNetworkPolicy CRD + this Composition
# are pre-applied via kubernetes_server's `manifests` attribute.
#
# Asserts admission + structural shape:
#   1. Composition admitted to apiserver.
#   2. compositeTypeRef.kind is XTenant.
#   3. mode = Pipeline.
#   4. The pipeline emits exactly three logical resources by name:
#      capsule-tenant, namespace, cilium-tenant-isolation.
#   5. The Composition is labeled monok8s.io/provider=capsule so XRs
#      can compositionSelector to it.
#
# Full child-resource RENDERING (crank render asserting the per-tenant
# Tenant CR + namespace + CiliumNetworkPolicy come out with the right
# patches) is the crossplane_render_test sibling target.

set -euo pipefail

KUBECTL="${KUBECTL:-kubectl}"

if [[ -z "${KUBECONFIG:-}" ]]; then
    echo "smoke: KUBECONFIG not set — itest_suite wrapper should have populated it" >&2
    exit 1
fi

echo "smoke: kubectl get composition tenant-capsule"
"$KUBECTL" get composition.apiextensions.crossplane.io tenant-capsule -o name

kind=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-capsule \
    -o jsonpath='{.spec.compositeTypeRef.kind}')
if [[ "$kind" != "XTenant" ]]; then
    echo "smoke: composition compositeTypeRef.kind is $kind, expected XTenant" >&2
    exit 1
fi

mode=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-capsule \
    -o jsonpath='{.spec.mode}')
if [[ "$mode" != "Pipeline" ]]; then
    echo "smoke: composition mode is '$mode'; expected 'Pipeline'" >&2
    exit 1
fi

resources=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-capsule \
    -o jsonpath='{.spec.pipeline[0].input.resources[*].name}')
expected="capsule-tenant namespace cilium-tenant-isolation"
if [[ "$resources" != "$expected" ]]; then
    echo "smoke: composition pipeline[0].input.resources[].name is '$resources'; expected '$expected'" >&2
    exit 1
fi

provider=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-capsule \
    -o jsonpath='{.metadata.labels.monok8s\.io/provider}')
if [[ "$provider" != "capsule" ]]; then
    echo "smoke: composition monok8s.io/provider label is '$provider'; expected 'capsule'" >&2
    exit 1
fi

echo "smoke: ok"
