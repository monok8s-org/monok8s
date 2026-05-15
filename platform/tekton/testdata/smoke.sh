#!/usr/bin/env bash
# Asserts the Tekton platform install's structural shape: bootstrap
# bundle (Pipelines v1.11.1) + 6 reusable Tasks per AC#2 + each Task
# is generic per AC#3 (no hardcoded service name).
set -euo pipefail

bootstrap=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*platform/tekton/bootstrap.yaml' 2>/dev/null | head -1)
[[ -f "$bootstrap" ]] || { echo "smoke: bootstrap.yaml not found"; exit 1; }

must() { grep -qE -- "$2" "$1" || { echo "smoke: $1 missing $3 ($2)"; exit 1; }; }

# Bootstrap: 4 Tekton Deployments + core CRDs.
must "$bootstrap" '^  name: tekton-pipelines-controller$'    'Pipelines controller'
must "$bootstrap" '^  name: tekton-pipelines-webhook$'       'Pipelines webhook'
must "$bootstrap" '^  name: tekton-events-controller$'       'events controller'
must "$bootstrap" '^  name: tekton-pipelines-remote-resolvers$' 'remote resolvers'
must "$bootstrap" '^  name: tasks\.tekton\.dev$'             'CRD tasks'
must "$bootstrap" '^  name: pipelines\.tekton\.dev$'         'CRD pipelines'
must "$bootstrap" '^  name: pipelineruns\.tekton\.dev$'      'CRD pipelineruns'
must "$bootstrap" '^  name: taskruns\.tekton\.dev$'          'CRD taskruns'

# 6 Tasks per #26 AC#2.
TASKS_DIR=$(dirname "$bootstrap")/tasks
for task_name in clone bazel-test bazel-build-image cosign-sign oci-push gitops-update; do
    f="$TASKS_DIR/$task_name.yaml"
    [[ -f "$f" ]] || { echo "smoke: missing Task $task_name.yaml"; exit 1; }
    grep -qE '^kind: Task$' "$f" || { echo "smoke: $f is not a Task"; exit 1; }
    grep -qE "^  name: $task_name$" "$f" || { echo "smoke: $f's metadata.name != $task_name"; exit 1; }
    # Generic per #26 AC#3 — no hardcoded service names like "monok8s-api".
    if grep -qE 'monok8s-api|monok8s-workers|monok8s-cli|monok8s-frontend' "$f"; then
        echo "smoke: $f hardcodes a service name (AC#3 violated)" >&2
        exit 1
    fi
    # Each Task uses params: for input drive — generic-by-construction.
    grep -qE '^\s*params:' "$f" || { echo "smoke: $f has no params: section"; exit 1; }
done

# apps-api-build Pipeline (#28) — composes the 6 Tasks.
PIPELINE=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*pipelines/api-build.yaml' 2>/dev/null | head -1)
[[ -f "$PIPELINE" ]] || { echo "smoke: api-build.yaml Pipeline not found"; exit 1; }
must "$PIPELINE" '^kind: Pipeline$'        'kind: Pipeline'
must "$PIPELINE" '^  name: apps-api-build$' 'pipeline name'
# All 6 Tasks referenced via taskRef.name.
for task_name in clone bazel-test bazel-build-image cosign-sign oci-push gitops-update; do
    must "$PIPELINE" "name: $task_name$" "Pipeline composes Task $task_name"
done
# Pipeline ordering: clone → test → build-image → push → sign → gitops.
must "$PIPELINE" 'runAfter: \[clone\]'        'test runs after clone'
must "$PIPELINE" 'runAfter: \[test\]'         'build-image runs after test'
must "$PIPELINE" 'runAfter: \[build-image\]'  'push runs after build-image'
must "$PIPELINE" 'runAfter: \[push\]'         'sign runs after push'
must "$PIPELINE" 'runAfter: \[sign\]'         'gitops-update runs after sign'
# Image push target: harbor.monok8s.internal per #28 AC#3.
must "$PIPELINE" 'harbor\.monok8s\.internal/monok8s/api'  'push destination'
# Digest pinning: signature + gitops update reference @<digest>, not :tag.
must "$PIPELINE" 'monok8s/api@\$\(tasks\.push\.results\.pushed-digest\)' 'digest-pinned signature'
# Gitops update path: apps/api/k8s/overlays/staging/kustomization.yaml per AC#5.
must "$PIPELINE" 'apps/api/k8s/overlays/staging/kustomization\.yaml' 'gitops file path'

# Staging overlay: digest-pinned for the gitops-update sed-replace pattern.
STAGING=$(find "${RUNFILES_DIR:-${TEST_SRCDIR:-$PWD}}" -path '*apps/api/k8s/overlays/staging/kustomization.yaml' 2>/dev/null | head -1)
[[ -f "$STAGING" ]] || { echo "smoke: staging kustomization.yaml not found"; exit 1; }
must "$STAGING" 'digest: sha256:[0-9a-f]{64}'   'digest-pinned image entry'
must "$STAGING" 'name: harbor\.monok8s\.internal/monok8s/api'  'image name matches Pipeline output'

echo "smoke: ok"
