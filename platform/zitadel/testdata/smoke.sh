#!/usr/bin/env bash
# Asserts the Zitadel platform install's structural shape: bootstrap
# (zitadel + Jobs + Secrets), CNPG Cluster, and the bootstrap Job
# that creates the monok8s project + monok8s-spa PKCE client.
set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/zitadel/bootstrap.yaml' 2>/dev/null | head -1)
cluster=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"   -path '*platform/zitadel/cluster.yaml' 2>/dev/null | head -1)
job=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"       -path '*platform/zitadel/bootstrap-job.yaml' 2>/dev/null | head -1)

for f in bootstrap cluster job; do
    eval p="\$$f"
    [[ -f "$p" ]] || { echo "smoke: $f file not found"; exit 1; }
done

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# bootstrap: Zitadel Deployment + the three init/setup Jobs.
must "$bootstrap" '^kind: Deployment$'             'Deployment'
must "$bootstrap" '^  name: zitadel$'              'zitadel resource'
must "$bootstrap" '^kind: Job$'                    'init/setup Jobs present'
must "$bootstrap" '^kind: Service$'                'Service'

# CNPG Cluster: zitadel-db.
must "$cluster"   '^kind: Cluster$'                'kind: Cluster'
must "$cluster"   '^  name: zitadel-db$'           'cluster name zitadel-db'

# Bootstrap Job: ConfigMap with monok8s project + spa client + RBAC.
must "$job" 'kind: ConfigMap$'                              'ConfigMap (script)'
must "$job" 'kind: Job$'                                    'kind: Job'
must "$job" 'name: zitadel-bootstrap-monok8s$'              'job name'
must "$job" '"name":"monok8s"'                              'monok8s project name'
must "$job" '"name": "monok8s-spa"'                         'monok8s-spa client name'
must "$job" '"appType": "OIDC_APP_TYPE_USER_AGENT"'         'PKCE app type'
must "$job" '"authMethodType": "OIDC_AUTH_METHOD_TYPE_NONE"' 'PKCE no-secret'
must "$job" 'name: monok8s-zitadel-config$'                 'consumer ConfigMap emitted'
must "$job" 'kind: ServiceAccount$'                         'ServiceAccount RBAC'
must "$job" 'kind: RoleBinding$'                            'RoleBinding'

echo "smoke: ok"
