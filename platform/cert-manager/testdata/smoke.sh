#!/usr/bin/env bash
set -euo pipefail
bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/cert-manager/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
must() { grep -qE -- "$1" "$bootstrap" || { echo "smoke: missing $2 ($1)"; exit 1; }; }
# CRDs + 3 Deployments + admission webhook.
must '^  name: certificates\.cert-manager\.io$'              'CRD certificates'
must '^  name: clusterissuers\.cert-manager\.io$'            'CRD clusterissuers'
must '^  name: issuers\.cert-manager\.io$'                   'CRD issuers'
must '^  name: certificaterequests\.cert-manager\.io$'       'CRD certificaterequests'
must '^kind: Deployment$'                                    'Deployment'
must '^  name: cert-manager$'                                'controller'
must '^  name: cert-manager-cainjector$'                     'cainjector'
must '^  name: cert-manager-webhook$'                        'webhook'
must '^kind: ValidatingWebhookConfiguration$'                'ValidatingWebhookConfiguration'
echo "smoke: ok"
