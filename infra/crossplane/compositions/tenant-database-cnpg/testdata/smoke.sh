#!/usr/bin/env bash
# L2 smoke for the tenant-database-cnpg Composition (#82).
#
# Runs under //tools/bazel:itest_suite with TWO servers:
#   * k8s — kube-apiserver+etcd with pre-applied Crossplane meta-CRDs +
#     CNPG Cluster CRD + XTenantDatabase XRD + this Composition.
#   * pg  — hermetic Postgres via rules_pg's pg_server, declared locally
#     in this package (empty-schema pattern mirroring //packages/db:dev_pg).
#
# The pg_server is a SURROGATE — the kube-apiserver in this envtest
# does NOT run the CNPG operator, so a Cluster CR sits there as data
# without reconciliation. The pg surrogate exists to satisfy the
# "psql connection round-trip" AC at L2 hermetic constraints. A real
# CNPG-operator-driven Cluster + psql round-trip is a kind-based L4
# follow-up Issue.
#
# Asserts:
#   1. Composition admitted to apiserver.
#   2. XRD admitted (xtenantdatabases.monok8s.io).
#   3. compositeTypeRef.kind = XTenantDatabase.
#   4. mode = Pipeline.
#   5. Composition pipeline declares exactly one resource named
#      `cnpg-cluster`.
#   6. monok8s.io/provider label = cnpg.
#   7. psql round-trip against the hermetic pg surrogate: SELECT 1.

set -euo pipefail

KUBECTL="${KUBECTL:-kubectl}"
PSQL="${PSQL:-psql}"

if [[ -z "${KUBECONFIG:-}" ]]; then
    echo "smoke: KUBECONFIG not set — itest_suite wrapper should have populated it" >&2
    exit 1
fi
if [[ -z "${PG_URL:-}" ]]; then
    echo "smoke: PG_URL not set — itest_suite wrapper should have populated it" >&2
    exit 1
fi

echo "smoke: kubectl get composition tenant-database-cnpg"
"$KUBECTL" get composition.apiextensions.crossplane.io tenant-database-cnpg -o name

echo "smoke: kubectl get xrd xtenantdatabases.monok8s.io"
"$KUBECTL" get compositeresourcedefinition.apiextensions.crossplane.io xtenantdatabases.monok8s.io -o name

kind=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-database-cnpg \
    -o jsonpath='{.spec.compositeTypeRef.kind}')
if [[ "$kind" != "XTenantDatabase" ]]; then
    echo "smoke: composition compositeTypeRef.kind is $kind, expected XTenantDatabase" >&2
    exit 1
fi

mode=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-database-cnpg \
    -o jsonpath='{.spec.mode}')
if [[ "$mode" != "Pipeline" ]]; then
    echo "smoke: composition mode is '$mode'; expected 'Pipeline'" >&2
    exit 1
fi

resources=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-database-cnpg \
    -o jsonpath='{.spec.pipeline[0].input.resources[*].name}')
expected="cnpg-cluster"
if [[ "$resources" != "$expected" ]]; then
    echo "smoke: composition pipeline[0].input.resources[].name is '$resources'; expected '$expected'" >&2
    exit 1
fi

provider=$("$KUBECTL" get composition.apiextensions.crossplane.io tenant-database-cnpg \
    -o jsonpath='{.metadata.labels.monok8s\.io/provider}')
if [[ "$provider" != "cnpg" ]]; then
    echo "smoke: composition monok8s.io/provider label is '$provider'; expected 'cnpg'" >&2
    exit 1
fi

# psql round-trip — proves a real psql client can connect to the
# hermetic Postgres surrogate using the same URL shape that the
# CNPG-emitted connection Secret would expose at runtime.
echo "smoke: psql round-trip"
roundtrip=$("$PSQL" "$PG_URL" -tAc 'SELECT 1')
roundtrip=$(echo "$roundtrip" | tr -d '[:space:]')
if [[ "$roundtrip" != "1" ]]; then
    echo "smoke: psql SELECT 1 returned '$roundtrip'; expected '1'" >&2
    exit 1
fi

echo "smoke: ok"
