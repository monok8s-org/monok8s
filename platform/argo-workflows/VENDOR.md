# Vendored Argo Workflows install manifest

Single-file install bundle from upstream Argo Workflows releases.
Reconciled into the cluster by the ArgoCD `Application` CR at
`platform/argocd/apps/argo-workflows.yaml`. Per Hermeticity
Discussion #4 Gap 3, this manifest is vendored (no network fetches at
build / test time).

## Source

- Repository: <https://github.com/argoproj/argo-workflows>
- Release: `v4.0.5`
- Asset: `install.yaml`
- URL: <https://github.com/argoproj/argo-workflows/releases/download/v4.0.5/install.yaml>
- sha256: `98f742908e1dba9becbd73e608f5c6a7434100eb9abe005f6057894cea0d45dc`

## Install shape

- **Namespace**: `argo` (hardcoded in the upstream manifest).
- **CRDs (8)**:
  - `workflows.argoproj.io`
  - `workflowtemplates.argoproj.io`
  - `cronworkflows.argoproj.io`
  - `clusterworkflowtemplates.argoproj.io`
  - `workflowtaskresults.argoproj.io`
  - `workflowtasksets.argoproj.io`
  - `workflowartifactgctasks.argoproj.io`
  - `workfloweventbindings.argoproj.io`
- **Deployments (2)**:
  - `workflow-controller` — the reconciler that drives Workflow CRs through
    their step graph.
  - `argo-server` — REST/gRPC API server; consumed by the Argo CLI + UI +
    Temporal-driven submissions in #84.
- **RBAC**: ClusterRoles + Roles + bindings for both Deployments.
- **No ValidatingWebhookConfiguration** — Argo Workflows doesn't ship
  one in this release; CRD admission is OpenAPIv3-schema-driven.

## Refresh procedure

```bash
VERSION=v4.0.5   # bump as needed; verify both Deployment names + CRD list
                # stay stable in the new release, or update VENDOR.md +
                # platform/argo-workflows/testdata/bootstrap_smoke.sh.
curl -sfL "https://github.com/argoproj/argo-workflows/releases/download/${VERSION}/install.yaml" \
  -o platform/argo-workflows/bootstrap.yaml
sha256sum platform/argo-workflows/bootstrap.yaml
```

Update `Release` + `URL` + `sha256` above after refresh. The
`bootstrap_smoke` test will fail if any of the 4 AC-required CRDs or
the 2 Deployments disappear; new CRDs upstream are silently accepted
(they extend the API surface without breaking #86/#83's WorkflowTemplate
manifests).

## Live operator validation

The `bootstrap_smoke` sh_test in `platform/argo-workflows/BUILD.bazel`
is pure-grep-based (no cluster, no Docker — same posture as
`platform/cloudnativepg/`). Live operator behavior (kubectl apply +
pods Ready + WorkflowTemplate submission) is exercised when ArgoCD
syncs the Application into a real cluster + when [#84](https://github.com/monok8s-org/monok8s-dev/issues/84)
lands the Temporal tenant-create workflow that submits the
WorkflowTemplates from #86 / #83.
