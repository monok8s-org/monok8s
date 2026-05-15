#!/usr/bin/env bash
# Asserts the Temporal platform install's structural shape: single-file
# operator bundle (CRDs + operator concatenated by rules_temporal
# v0.3.0) + CNPG Cluster + TemporalCluster CR. Plus: the
# TemporalCluster references temporal-db (the CNPG cluster) for both
# the core temporal schema and the temporal_visibility schema.
set -euo pipefail

operator=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/temporal/operator-bootstrap.yaml' 2>/dev/null | head -1)
cluster=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"  -path '*platform/temporal/cluster.yaml' 2>/dev/null | head -1)
temporal=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/temporal/temporalcluster.yaml' 2>/dev/null | head -1)

for f in operator cluster temporal; do
    eval p="\$$f"
    [[ -f "$p" ]] || { echo "smoke: $f file not found"; exit 1; }
done

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# Operator bundle (CRDs + ops concatenated): 4 Temporal CRDs +
# Deployment + cert-manager Issuer + webhooks all in one file.
must "$operator" '^  name: temporalclusters\.temporal\.io$'        'CRD temporalclusters'
must "$operator" '^  name: temporalnamespaces\.temporal\.io$'      'CRD temporalnamespaces'
must "$operator" '^  name: temporalclusterclients\.temporal\.io$'  'CRD temporalclusterclients'
must "$operator" '^  name: temporalschedules\.temporal\.io$'       'CRD temporalschedules'
must "$operator" '^kind: Deployment$'                              'operator Deployment'
must "$operator" '^kind: Issuer$'                                  'cert-manager Issuer (webhook TLS)'
must "$operator" '^kind: ValidatingWebhookConfiguration$'          'ValidatingWebhookConfiguration'
must "$operator" '^kind: MutatingWebhookConfiguration$'            'MutatingWebhookConfiguration'

# CNPG Cluster: temporal-db with database + visibility companion.
must "$cluster"  '^kind: Cluster$'                            'kind: Cluster'
must "$cluster"  '^  name: temporal-db$'                      'cluster name temporal-db'
must "$cluster"  'database: temporal$'                        'database temporal'
must "$cluster"  'CREATE DATABASE temporal_visibility'        'visibility schema bootstrap'

# TemporalCluster: 4 services + UI + persistence backed by CNPG.
must "$temporal" '^kind: TemporalCluster$'                            'kind: TemporalCluster'
must "$temporal" 'history:'                                           'history service'
must "$temporal" 'matching:'                                          'matching service'
must "$temporal" 'frontend:'                                          'frontend service'
must "$temporal" 'worker:'                                            'worker service'
must "$temporal" 'temporal-db-rw\.temporal\.svc'                      'CNPG read-write Service'
must "$temporal" 'databaseName: temporal$'                            'temporal default-store db'
must "$temporal" 'databaseName: temporal_visibility$'                 'visibility-store db'
must "$temporal" '^  ui:$'                                            'UI block'
must "$temporal" 'enabled: true$'                                     'UI enabled'

echo "smoke: ok"
