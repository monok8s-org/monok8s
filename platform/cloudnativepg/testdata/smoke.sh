#!/usr/bin/env bash
set -euo pipefail
bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/cloudnativepg/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
must() { grep -qE -- "$1" "$bootstrap" || { echo "smoke: missing $2 ($1)"; exit 1; }; }
# Operator + Cluster CRD + key Deployment.
must '^  name: clusters\.postgresql\.cnpg\.io$'   'CRD clusters.postgresql.cnpg.io'
must '^  name: poolers\.postgresql\.cnpg\.io$'    'CRD poolers (PgBouncer)'
must '^  name: backups\.postgresql\.cnpg\.io$'    'CRD backups'
must '^kind: Deployment$'                         'operator Deployment'
must '^  name: cnpg-cloudnative-pg$'              'cnpg-cloudnative-pg Deployment'
must '^kind: ValidatingWebhookConfiguration$'     'ValidatingWebhookConfiguration'
echo "smoke: ok"
