#!/usr/bin/env bash
# Asserts the NATS platform install's vendored chart-render shape:
# core control-plane resources from the upstream nats Helm chart 2.12.6,
# the floor-of-1 baseline (StatefulSet replicas: 1) per Discussion #76,
# and JetStream enabled in the rendered nats.conf.
set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/nats/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# Core nats Helm chart 2.12.6 control-plane resources (vendor ledger
# at platform/nats/VENDOR.md). Resource kinds + names asserted, not
# the Helm labels — the labels are render-stable but consumers should
# not depend on their text.
must "$bootstrap" '^kind: PodDisruptionBudget$' 'PodDisruptionBudget kind'
must "$bootstrap" '^kind: ConfigMap$'           'ConfigMap kind'
must "$bootstrap" '^kind: Service$'             'Service kind'
must "$bootstrap" '^kind: StatefulSet$'         'StatefulSet kind (nats-server)'
must "$bootstrap" '^kind: Deployment$'          'Deployment kind (nats-box)'

must "$bootstrap" '^  name: nats$'              'StatefulSet/Service/PDB named nats'
must "$bootstrap" '^  name: nats-headless$'     'headless Service named nats-headless'
must "$bootstrap" '^  name: nats-config$'       'ConfigMap named nats-config'
must "$bootstrap" '^  name: nats-box$'          'nats-box Deployment'
must "$bootstrap" '^  name: nats-box-contexts$' 'nats-box-contexts Secret'

# Floor-of-1 baseline per Discussion #76 — single nats-server pod at
# idle. The matching nats-box Deployment also runs replicas: 1.
[[ $(grep -cE '^  replicas: 1$' "$bootstrap") -ge 2 ]] \
    || { echo "smoke: expected replicas: 1 on both StatefulSet and nats-box Deployment"; exit 1; }

# JetStream enabled in the rendered nats.conf (chart default is OFF;
# rules_nats overlays it on via config/nats-values.yaml — see VENDOR.md).
must "$bootstrap" '"jetstream"' 'jetstream block in rendered nats.conf'

echo "smoke: ok (nats)"
