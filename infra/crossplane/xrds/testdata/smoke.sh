#!/usr/bin/env bash
# L2 smoke for the XTenant XRD.
#
# Runs under the wrapper from //tools/bazel:itest.bzl with KUBECONFIG
# pointing at a kube-apiserver+etcd envtest. The Crossplane meta-CRD
# (CompositeResourceDefinition) is pre-applied via kubernetes_server's
# `manifests` attribute, so on entry the cluster knows what an XRD is.
#
# What this asserts:
#   1. The XTenant XRD got applied cleanly by kubernetes_server (no
#      schema rejection by the meta-CRD).
#   2. kubectl can read the XRD back by name.
#   3. The fixture under testdata/ has the exact required spec shape
#      (name + postgresVersion in {14,15,16}). Schema validation
#      against the XRD's OpenAPIV3 schema runs at L4 (#37) where the
#      Crossplane controller is installed and reconciles XRD -> XR CRD.

set -euo pipefail

# rules_kubernetes points $KUBECONFIG and $KUBECTL at runtime.
KUBECTL="${KUBECTL:-kubectl}"

# Under bzlmod, runfiles for the main workspace live at
# ${RUNFILES_DIR}/_main/<path>. Without the _main/ prefix the script
# constructs a non-existent path and false-fails on "fixture not found".
fixture="${RUNFILES_DIR:-${TEST_SRCDIR}}/_main/infra/crossplane/xrds/testdata/valid-xtenant.yaml"

if [[ -z "${KUBECONFIG:-}" ]]; then
    echo "smoke: KUBECONFIG not set — itest_suite wrapper should have populated it" >&2
    exit 1
fi

echo "smoke: kubectl get xrd xtenants.monok8s.io"
"$KUBECTL" get compositeresourcedefinition.apiextensions.crossplane.io xtenants.monok8s.io -o name

echo "smoke: fixture shape check"
if [[ ! -f "$fixture" ]]; then
    echo "smoke: fixture not found at $fixture" >&2
    exit 1
fi

# Required: spec.name, spec.postgresVersion in {14,15,16}.
grep -qE '^  name:[[:space:]]+[a-z0-9]' "$fixture" \
    || { echo "smoke: fixture spec.name missing or invalid"; exit 1; }
grep -qE '^  postgresVersion:[[:space:]]+"(14|15|16)"' "$fixture" \
    || { echo "smoke: fixture spec.postgresVersion not in {14,15,16}"; exit 1; }

echo "smoke: ok"
