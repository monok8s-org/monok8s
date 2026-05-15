#!/usr/bin/env bash
# Validates the vendored Argo CD bootstrap manifest's shape: the file is
# a multi-doc YAML matching the upstream v3.3.8 install.yaml, so the
# expected core resources MUST be present. A failure here means either
# (a) the wrong tag was vendored, or (b) the file got corrupted on its
# way into the repo. Cheap & deterministic — no cluster needed.
#
# Hermeticity-wise, this is the static-shape gate that Hermeticity
# Discussion #4 Gap 3 calls for ("manifests vendored as Bazel target
# inputs"); the runtime reconciliation lives in the L4 #37 demo path.

set -euo pipefail

bootstrap="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}/_main}/platform/argocd/bootstrap.yaml"
appset="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}/_main}/platform/argocd/appsets/platform-apps.yaml"
selfapp="${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}/_main}/platform/argocd/apps/argocd.yaml"

# Some `bazel test` runs leave RUNFILES_DIR + TEST_SRCDIR pointing at
# different layouts; fall back to a brute-force search if the canonical
# path doesn't exist.
if [[ ! -f "$bootstrap" ]]; then
    bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -name bootstrap.yaml 2>/dev/null | head -1)
fi
if [[ ! -f "$appset" ]]; then
    appset=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*argocd/appsets/platform-apps.yaml' 2>/dev/null | head -1)
fi
if [[ ! -f "$selfapp" ]]; then
    selfapp=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*argocd/apps/argocd.yaml' 2>/dev/null | head -1)
fi

[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }
[[ -f "$appset"    ]] || { echo "smoke: platform-apps.yaml not found"; exit 1; }
[[ -f "$selfapp"   ]] || { echo "smoke: apps/argocd.yaml not found"; exit 1; }

# 1. bootstrap.yaml carries the expected core Argo CD resources.
must_grep() {
    local pattern="$1" label="$2"
    grep -qE "$pattern" "$bootstrap" \
        || { echo "smoke: bootstrap.yaml missing $label (pattern: $pattern)"; exit 1; }
}

must_grep '^  name: applications\.argoproj\.io$'       'CRD applications.argoproj.io'
must_grep '^  name: applicationsets\.argoproj\.io$'    'CRD applicationsets.argoproj.io'
must_grep '^  name: appprojects\.argoproj\.io$'        'CRD appprojects.argoproj.io'
must_grep '^kind: Deployment$'                         'at least one Deployment'
must_grep '^  name: argocd-server$'                    'argocd-server resource'
must_grep '^  name: argocd-application-controller$'    'argocd-application-controller resource'
must_grep '^  name: argocd-repo-server$'               'argocd-repo-server resource'
must_grep '^  name: argocd-applicationset-controller$' 'argocd-applicationset-controller resource'

# 2. ApplicationSet auto-discovers apps/*.
grep -qE 'kind:\s*ApplicationSet'      "$appset" || { echo "smoke: platform-apps not an ApplicationSet"; exit 1; }
grep -qE 'directories:'                "$appset" || { echo "smoke: platform-apps missing git directory generator"; exit 1; }
grep -qE 'platform/argocd/apps/'       "$appset" || { echo "smoke: platform-apps doesn't point at apps/"; exit 1; }

# 3. Self-managed Argo CD app references this same bootstrap source.
grep -qE 'kind:\s*Application'         "$selfapp" || { echo "smoke: apps/argocd not an Application"; exit 1; }
grep -qE 'path:\s*platform/argocd'     "$selfapp" || { echo "smoke: self-app path does not point at platform/argocd"; exit 1; }
grep -qE 'include:\s*bootstrap\.yaml'  "$selfapp" || { echo "smoke: self-app does not include bootstrap.yaml"; exit 1; }

echo "smoke: ok"
