# `platform/argocd/bootstrap.yaml` provenance

`bootstrap.yaml` is the verbatim Argo CD upstream install manifest. Per
Hermeticity Discussion #4 Gap 3, manifests applied from this repo are
**vendored** — `kubectl apply -f bootstrap.yaml` makes no network call to
upstream registries at sync time. Argo CD itself reconciles its own
Application via the self-managed `apps/argocd.yaml`, which points back at
this same bootstrap source on the dev branch.

## Refresh procedure

```bash
VERSION=v3.3.8   # bump as needed; pair with rules_argocd's pinned version
curl -sfL "https://raw.githubusercontent.com/argoproj/argo-cd/${VERSION}/manifests/install.yaml" \
  -o platform/argocd/bootstrap.yaml
```

Record the version + sha256 + size here on every refresh. Pair the bump
with the rules_argocd version pin in `MODULE.bazel` so the in-tree
test toolchain stays consistent with the deployed manifest.

| File | Argo CD version | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v3.3.8` | `75390e0cc232195d6d1a9614631f2beb0baa23ef227db380351ea235904a1f0d` | 1,883,448 |
