#!/usr/bin/env bash
# Asserts the Harbor platform install's structural shape: vendored
# bootstrap (5 Deployments + 1 StatefulSet for trivy/jobservice/etc.),
# CNPG cluster, kustomize patches that swap the internal Postgres for
# CNPG, both storage overlays, and the ArgoCD app's internal-LB-only
# routing per AC#4.
set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/harbor/base/bootstrap.yaml' 2>/dev/null | head -1)
cluster=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"   -path '*platform/harbor/base/cluster.yaml' 2>/dev/null | head -1)
patches=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"   -path '*platform/harbor/base/cnpg-patches.yaml' 2>/dev/null | head -1)
basekz=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"    -path '*platform/harbor/base/kustomization.yaml' 2>/dev/null | head -1)
bm_kz=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"     -path '*overlays/baremetal/kustomization.yaml' 2>/dev/null | head -1)
gcp_kz=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"    -path '*overlays/gcp/kustomization.yaml' 2>/dev/null | head -1)
gcp_patch=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*overlays/gcp/gcs-patch.yaml' 2>/dev/null | head -1)

for f in bootstrap cluster patches basekz bm_kz gcp_kz gcp_patch; do
    eval p="\$$f"
    [[ -f "$p" ]] || { echo "smoke: $f file not found"; exit 1; }
done

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# Bootstrap: AC#1 + AC#4 (internal LB only via expose.type=clusterIP).
# The chart-render mixes quoted and unquoted name forms — accept both.
must "$bootstrap" '^  name: "?harbor-core"?$'        'harbor-core Deployment'
must "$bootstrap" '^  name: "?harbor-portal"?$'      'harbor-portal Deployment'
must "$bootstrap" '^  name: "?harbor-jobservice"?$'  'harbor-jobservice Deployment'
must "$bootstrap" '^  name: "?harbor-registry"?$'    'harbor-registry Deployment'
must "$bootstrap" '^  name: "?harbor-nginx"?$'       'harbor-nginx (internal LB reverse-proxy)'
# AC#4: clusterIP-only — no LoadBalancer / NodePort Service in the bundle.
if grep -E '^\s*type:\s*(LoadBalancer|NodePort)$' "$bootstrap" > /dev/null; then
    echo "smoke: bootstrap has a LoadBalancer/NodePort Service (AC#4 violated)" >&2
    exit 1
fi

# Per-Harbor CNPG cluster (AC#2 — separate database).
must "$cluster" '^kind: Cluster$'                 'kind: Cluster'
must "$cluster" '^  name: harbor-db$'             'cluster name harbor-db'
must "$cluster" 'database: registry$'             'registry database'
must "$cluster" 'CREATE DATABASE notary_server'   'notary_server companion database'
must "$cluster" 'CREATE DATABASE notary_signer'   'notary_signer companion database'

# CNPG patches: delete the internal StatefulSet + ExternalName the Service.
must "$patches" '\$patch: delete$'                                    'StatefulSet delete patch'
must "$patches" 'kind: StatefulSet$'                                  'StatefulSet kind in patch'
must "$patches" '^  name: harbor-database$'                           'targets harbor-database'
must "$patches" 'type: ExternalName$'                                 'ExternalName Service'
must "$patches" 'externalName: harbor-db-rw\.harbor\.svc.cluster.local' 'aliases CNPG read-write Service'

# Base kustomization wires bootstrap + cluster + patches.
must "$basekz" 'resources:'         'resources block'
must "$basekz" 'bootstrap\.yaml'    'bootstrap.yaml referenced'
must "$basekz" 'cluster\.yaml'      'cluster.yaml referenced'
must "$basekz" 'cnpg-patches\.yaml' 'cnpg patches referenced'

# Overlays per AC#3.
must "$bm_kz"  '\.\./\.\./base'            'baremetal overlay extends base'
must "$gcp_kz" '\.\./\.\./base'            'gcp overlay extends base'
must "$gcp_kz" 'gcs-patch\.yaml'           'gcp overlay applies gcs patch'
must "$gcp_patch" 'gcs:$'                  'GCS storage driver'
must "$gcp_patch" 'bucket: monok8s-harbor' 'bucket configured'

echo "smoke: ok (harbor)"
