#!/usr/bin/env bash
# Asserts the SpiceDB platform install's structural shape: operator
# bundle, CNPG Cluster, SpiceDBCluster, schema.zed, bootstrap Job.
# Plus: schema.zed and the ConfigMap-embedded schema are kept in sync
# (the bootstrap Job loads the ConfigMap copy into SpiceDB).
set -euo pipefail

operator=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/spicedb/operator-bootstrap.yaml' 2>/dev/null | head -1)
cluster=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"  -path '*platform/spicedb/cluster.yaml' 2>/dev/null | head -1)
spicedb=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"  -path '*platform/spicedb/spicedbcluster.yaml' 2>/dev/null | head -1)
schema=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"   -path '*platform/spicedb/schema.zed' 2>/dev/null | head -1)
boot=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"     -path '*platform/spicedb/schema-bootstrap-job.yaml' 2>/dev/null | head -1)

for f in operator cluster spicedb schema boot; do
    eval p="\$$f"
    [[ -f "$p" ]] || { echo "smoke: $f file not found"; exit 1; }
done

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# spicedb-operator: CRDs + operator Deployment.
must "$operator" '^  name: spicedbclusters\.authzed\.com$' 'CRD spicedbclusters'
must "$operator" '^kind: Deployment$'                     'operator Deployment'

# CNPG Cluster: spicedb-db with database+owner=spicedb.
must "$cluster"  '^kind: Cluster$'           'kind: Cluster'
must "$cluster"  '^  name: spicedb-db$'      'cluster name spicedb-db'
must "$cluster"  'database: spicedb$'        'database name spicedb'

# SpiceDBCluster: postgres engine.
must "$spicedb"  '^kind: SpiceDBCluster$'        'kind: SpiceDBCluster'
must "$spicedb"  'datastoreEngine: postgres$'    'postgres datastore'

# schema.zed: required definitions per AC#2.
must "$schema"   '^definition user'                          'definition user'
must "$schema"   '^definition tenant'                        'definition tenant'
must "$schema"   '^    relation member: user'                'tenant.member'
must "$schema"   '^    relation write:'                      'tenant.write'
must "$schema"   '^    relation read:'                       'tenant.read'

# Bootstrap Job + ConfigMap.
must "$boot" '^kind: ConfigMap$'    'ConfigMap'
must "$boot" '^kind: Job$'          'Job'
must "$boot" 'zed schema write'     'zed schema write invocation'

# Schema sync: every relation in schema.zed appears in the ConfigMap.
for needle in 'definition user' 'definition tenant' 'relation member' 'relation write:' 'relation read:'; do
    grep -qF -- "$needle" "$schema" || { echo "smoke: schema.zed missing '$needle'"; exit 1; }
    grep -qF -- "$needle" "$boot"   || { echo "smoke: bootstrap Job ConfigMap missing '$needle' (schema drift!)"; exit 1; }
done

echo "smoke: ok"
