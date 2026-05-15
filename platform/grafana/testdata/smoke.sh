#!/usr/bin/env bash
# Asserts the Grafana platform install + 3-signal datasources + 2
# dashboards (Temporal worker per AC#4 + OnboardTenant per AC#5).
set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/grafana/bootstrap.yaml' 2>/dev/null | head -1)
ds=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"        -path '*platform/grafana/datasources.yaml' 2>/dev/null | head -1)
worker=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"    -path '*dashboards/temporal-worker.yaml' 2>/dev/null | head -1)
onboard=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}"   -path '*dashboards/onboard-tenant.yaml' 2>/dev/null | head -1)

for f in bootstrap ds worker onboard; do
    eval p="\$$f"
    [[ -f "$p" ]] || { echo "smoke: $f file not found"; exit 1; }
done

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# Bootstrap shape.
must "$bootstrap" '^kind: Deployment$'  'Grafana Deployment'
must "$bootstrap" '^kind: Service$'     'Service'
must "$bootstrap" '^kind: ConfigMap$'   'ConfigMap'

# Datasources: Loki + Mimir + Tempo all wired.
must "$ds" 'grafana_datasource: "1"'    'sidecar discovery label'
must "$ds" '^      - name: Loki$'       'Loki datasource'
must "$ds" '^      - name: Mimir$'      'Mimir datasource'
must "$ds" '^      - name: Tempo$'      'Tempo datasource'
must "$ds" 'loki\.loki\.svc'            'Loki in-cluster URL'
must "$ds" 'mimir\.mimir\.svc'          'Mimir in-cluster URL'
must "$ds" 'tempo\.tempo\.svc'          'Tempo in-cluster URL'

# Dashboards: both labeled grafana_dashboard=1 + reference correct datasources.
must "$worker"  'grafana_dashboard: "1"'  'worker dashboard discovery label'
must "$worker"  '"uid": "temporal-worker"' 'worker dashboard uid'
must "$worker"  'temporal_worker'         'worker dashboard metric name'
must "$onboard" 'grafana_dashboard: "1"'  'onboard dashboard discovery label'
must "$onboard" '"uid": "onboard-tenant"' 'onboard dashboard uid'
must "$onboard" 'OnboardTenantWorkflow'   'OnboardTenant workflow_type filter'
must "$onboard" 'monok8s-api'             'service.name filter for tenant.create span'

echo "smoke: ok (grafana)"
