# `infra/crossplane/vendor/`

Vendored CRDs used by `infra/crossplane/` envtest targets. Per Hermeticity
Discussion #4 Gap 3, manifests consumed by Bazel test targets are vendored
— no network fetches at build/test time.

## Refresh procedure

### Crossplane CRDs

```bash
VERSION=v2.2.1   # bump as needed
for crd in apiextensions.crossplane.io_compositeresourcedefinitions \
           apiextensions.crossplane.io_compositions; do
  curl -sfL "https://raw.githubusercontent.com/crossplane/crossplane/${VERSION}/cluster/crds/${crd}.yaml" \
    -o "infra/crossplane/vendor/${crd}.yaml"
done
```

### Capsule Tenant CRD

Sliced out of `platform/capsule/bootstrap.yaml` (the same install bundle
managed by `rules_capsule`). The single-doc extraction:

```bash
awk '
  BEGIN { is_tenant=0; buf="---\n" }
  /^---$/ {
    if (is_tenant) { print buf }
    is_tenant=0; buf="---\n"; next
  }
  {
    buf = buf $0 "\n"
    if ($0 ~ /^  name: tenants\.capsule\.clastix\.io$/) is_tenant=1
  }
  END { if (is_tenant) print buf }
' platform/capsule/bootstrap.yaml \
  > infra/crossplane/vendor/capsule.clastix.io_tenants.yaml
```

### Cilium CiliumNetworkPolicy CRD

```bash
VERSION=v1.16.5   # must match the rules_cilium pin in MODULE.bazel
curl -sfL "https://raw.githubusercontent.com/cilium/cilium/${VERSION}/pkg/k8s/apis/cilium.io/client/crds/v2/ciliumnetworkpolicies.yaml" \
  -o infra/crossplane/vendor/cilium.io_ciliumnetworkpolicies.yaml
```

Cilium installs its CRDs at runtime via the agent (not via Helm manifests),
so `rules_cilium`'s install bundle doesn't ship them — see Discussion #45
Gap 22 (rules_cilium follow-up to expose the CRD bundle as a Bazel-visible
target).

### CNPG Cluster CRD

Sliced out of `platform/cloudnativepg/bootstrap.yaml` (the same install
bundle managed by ArgoCD). The single-doc extraction follows the same
shape as the Capsule Tenant CRD:

```bash
awk '
  BEGIN { is_cnpg=0; buf="---\n" }
  /^---$/ {
    if (is_cnpg) { print buf }
    is_cnpg=0; buf="---\n"; next
  }
  {
    buf = buf $0 "\n"
    if ($0 ~ /^  name: clusters\.postgresql\.cnpg\.io$/) is_cnpg=1
  }
  END { if (is_cnpg) print buf }
' platform/cloudnativepg/bootstrap.yaml \
  > infra/crossplane/vendor/postgresql.cnpg.io_clusters.yaml
```

## Version + sha256 record

| File | Source version | sha256 |
|---|---|---|
| `apiextensions.crossplane.io_compositeresourcedefinitions.yaml` | Crossplane `v2.2.1` | `6825e4d61a7c6a64eb5d58231be2d1398d3550cb20fea58f6dedeea9c077f6c2` |
| `apiextensions.crossplane.io_compositions.yaml` | Crossplane `v2.2.1` | `13951a1af3ca5afa49c7fb9ddde423f59dc172026bcb8131b62e3e402c3fa309` |
| `capsule.clastix.io_tenants.yaml` | Capsule `0.10.4` (sliced from `platform/capsule/bootstrap.yaml`) | `65561df47519893d16260e9f9b059a1532c8d9f446c73891b688678091f6d2ef` |
| `cilium.io_ciliumnetworkpolicies.yaml` | Cilium `v1.16.5` | `60606cb4060a25a2131461773939714d1c0dbd910273449e68d0caf39927249c` |
| `postgresql.cnpg.io_clusters.yaml` | CNPG (sliced from `platform/cloudnativepg/bootstrap.yaml`; controller-gen `v0.20.1`) | `83749404c01cf8872a83a7a2c83751cc0982cd4760bc5aa44bbcb72affa5f29b` |
