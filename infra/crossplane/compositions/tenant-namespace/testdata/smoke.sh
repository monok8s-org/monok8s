#!/usr/bin/env bash
# L2 smoke for the tenant-namespace Composition.
#
# Runs under the //tools/bazel:itest_suite wrapper with KUBECONFIG
# pointing at a kube-apiserver+etcd envtest. The Crossplane meta-CRDs
# (CompositeResourceDefinition + Composition) and the XTenant XRD are
# pre-applied via kubernetes_server's `manifests` attribute.
#
# What this asserts:
#   1. The tenant-namespace Composition got applied cleanly by the
#      kubernetes_server bring-up (no schema rejection by the
#      Composition meta-CRD).
#   2. kubectl can read the Composition back by name.
#   3. The Composition declares exactly four logical resources:
#      Namespace, CloudNativePG Cluster, Vault Policy + Role, and
#      ExternalSecret. Counted by `kubectl get composition -o yaml`
#      + grep on the resources[].name list.
#   4. compositeTypeRef.kind is XTenant.
#
# Full child-resource RENDERING (`crank render` over the Composition
# + a fixture XTenant, asserting the four child manifests come out
# right) needs Crossplane's CLI binary or controller. That's tracked
# as a follow-up gap in Discussion #45 — pending a `rules_crossplane`
# Bazel rule. Here we validate Composition admission + structural
# shape only.

set -euo pipefail

KUBECTL="${KUBECTL:-kubectl}"

if [[ -z "${KUBECONFIG:-}" ]]; then
    echo "smoke: KUBECONFIG not set — itest_suite wrapper should have populated it" >&2
    exit 1
fi

# 1. Composition admitted to apiserver.
echo "smoke: kubectl get composition tenant-namespace"
"$KUBECTL" get composition.apiextensions.crossplane.io tenant-namespace -o name

# 2. compositeTypeRef.kind is XTenant.
kind=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-namespace \
    -o jsonpath='{.spec.compositeTypeRef.kind}')
if [[ "$kind" != "XTenant" ]]; then
    echo "smoke: composition compositeTypeRef.kind is $kind, expected XTenant" >&2
    exit 1
fi

# 3. Pipeline mode + function-patch-and-transform per Crossplane v2.
#    Resources live under spec.pipeline[0].input.resources[].
mode=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-namespace \
    -o jsonpath='{.spec.mode}')
if [[ "$mode" != "Pipeline" ]]; then
    echo "smoke: composition mode is '$mode'; expected 'Pipeline'" >&2
    exit 1
fi

# 4. Six resource entries (Namespace, CNPG Cluster, Vault Policy +
#    AuthBackendRole + ExternalSecret for KV-secret path, plus the
#    per-tenant transit-key Vault Policy added in #83).
resources=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-namespace \
    -o jsonpath='{.spec.pipeline[0].input.resources[*].name}')
expected="namespace postgres-cluster vault-policy vault-role vault-transit-policy db-creds"
if [[ "$resources" != "$expected" ]]; then
    echo "smoke: composition pipeline[0].input.resources[].name is '$resources'; expected '$expected'" >&2
    exit 1
fi

echo "smoke: ok"
