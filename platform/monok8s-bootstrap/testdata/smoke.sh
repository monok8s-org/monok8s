#!/usr/bin/env bash
# L1 structural smoke for platform/monok8s-bootstrap (#98a).
#
# Validates the Job + RBAC + ArgoCD Application + Secret template
# manifests are structurally well-formed via pure-grep on key
# invariants. Hermetic — no kubectl on PATH required. Mirrors the
# platform/zitadel/testdata/smoke.sh pattern.
set -euo pipefail

job=$(find       "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/monok8s-bootstrap/bootstrap-job.yaml'   2>/dev/null | head -1)
rbac=$(find      "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/monok8s-bootstrap/rbac.yaml'            2>/dev/null | head -1)
app=$(find       "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/monok8s-bootstrap/argocd-app.yaml'      2>/dev/null | head -1)
template=$(find  "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/monok8s-bootstrap/secret-template.yaml' 2>/dev/null | head -1)

for f in job rbac app template; do
    eval p="\$$f"
    [[ -f "$p" ]] || { echo "smoke: $f file not found"; exit 1; }
done

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# bootstrap-job.yaml: Job in install namespace with the expected SA + Secret mounts.
must "$job"  '^kind: Job$'                            'kind: Job'
must "$job"  '^  name: monok8s-bootstrap$'            'Job name monok8s-bootstrap'
must "$job"  '^  namespace: install$'                 'install namespace'
must "$job"  'serviceAccountName: monok8s-bootstrap'  'SA reference'
must "$job"  'secretName: zitadel-admin-sa'           'zitadel-admin-sa Secret mount'
must "$job"  'argocd.argoproj.io/sync-wave'           'ArgoCD sync-wave annotation'
must "$job"  'TEMPORAL_ADDRESS'                       'TEMPORAL_ADDRESS env var'
must "$job"  'SPICEDB_ENDPOINT'                       'SPICEDB_ENDPOINT env var'
must "$job"  'ZITADEL_API'                            'ZITADEL_API env var'

# rbac.yaml: ServiceAccount + Role + RoleBinding + ClusterRole + ClusterRoleBinding.
must "$rbac" '^kind: ServiceAccount$'                 'ServiceAccount'
must "$rbac" '^kind: Role$'                           'Role'
must "$rbac" '^kind: RoleBinding$'                    'RoleBinding'
must "$rbac" '^kind: ClusterRole$'                    'ClusterRole'
must "$rbac" '^kind: ClusterRoleBinding$'             'ClusterRoleBinding'
must "$rbac" 'monok8s-bootstrap-admin'                'monok8s-bootstrap-admin Secret in resourceNames'
must "$rbac" 'zitadel-admin-sa'                       'zitadel-admin-sa Secret in resourceNames'
must "$rbac" 'resources: \["xtenants"\]'              'XTenant cluster-wide read'

# argocd-app.yaml: ArgoCD Application CR with serverside-apply.
must "$app"  '^kind: Application$'                    'ArgoCD Application'
must "$app"  '^  name: monok8s-bootstrap$'            'App name'
must "$app"  'path: platform/monok8s-bootstrap'       'source path'
must "$app"  'ServerSideApply=true'                   'server-side apply'

# secret-template.yaml: documents the operator-applied Secret shape.
must "$template" '^kind: Secret$'                     'Secret kind'
must "$template" '^  name: monok8s-bootstrap-admin$'  'Secret name'
must "$template" 'email:'                             'email key'
must "$template" 'initialPassword:'                   'initialPassword key'

echo "smoke: ok"
