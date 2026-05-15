# Vendored Crossplane operator install manifest

Helm-rendered install bundle for the Crossplane controller. Reconciled
into the cluster by the ArgoCD `Application` CR at
`platform/argocd/apps/crossplane.yaml`. Per Hermeticity Discussion #4
Gap 3, this manifest is vendored (no network fetches at build / test
time).

## Source

- Repository: <https://github.com/crossplane/crossplane>
- Helm repo: `https://charts.crossplane.io/stable`
- Chart: `crossplane-stable/crossplane`
- Version: `2.2.1` (matches the meta-CRD versions vendored at
  `infra/crossplane/vendor/apiextensions.crossplane.io_*`)
- sha256: `b600e0df95ae993301fccf93c762a297db4b98fffa7315e4f4cdce9ffb41f4d5`

## Install shape

- **Namespace**: `crossplane-system` (created by ArgoCD's
  `CreateNamespace=true` syncOption).
- **CRDs**: **not bundled in the helm chart**. Crossplane v2's design
  is for the controller to install its own CRDs at startup once it has
  cluster-admin via the `crossplane` ClusterRole below. The L2
  envtests under `infra/crossplane/compositions/*/` instead apply the
  meta-CRDs directly from `infra/crossplane/vendor/` because there's no
  Crossplane controller running in envtest. The L4 path (#145) waits
  for the controller Deployment to become ready, then waits for the
  meta-CRDs to exist before applying XRDs.
- **Deployments (2)**:
  - `crossplane` — the core reconciler.
  - `crossplane-rbac-manager` — manages ClusterRole aggregation labels.
- **ServiceAccounts**: `crossplane`, `rbac-manager`.
- **ClusterRoles + bindings**: `crossplane` (full cluster-admin needed
  to install CRDs + reconcile XRs), `crossplane-rbac-manager`, plus the
  aggregation-target ClusterRoles for `crossplane-admin` / `-edit` /
  `-view` / `-browse` permission tiers.
- **Service**: `crossplane-webhooks` — admission webhook target.
- **Secrets**: `crossplane-root-ca`, `crossplane-tls-server`,
  `crossplane-tls-client` — TLS material for the admission webhook.

## Refresh procedure

```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm repo update
helm template crossplane crossplane-stable/crossplane \
    --version 2.2.1 \
    --namespace crossplane-system \
    --include-crds \
  > platform/crossplane/bootstrap.yaml

# Verify shape:
bazel test //platform/crossplane:bootstrap_smoke

# Recompute sha256:
sha256sum platform/crossplane/bootstrap.yaml
```

Bump the chart version + recompute the sha256 + re-render. The smoke
test catches structural breakage; semver compatibility with consumers
(`infra/crossplane/` XRDs) is the operator's responsibility.
