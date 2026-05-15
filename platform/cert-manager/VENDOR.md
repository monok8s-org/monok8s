# `platform/cert-manager/bootstrap.yaml` provenance

cert-manager install, fetched from the upstream release at the version
pinned in `rules_certmanager`'s `private/versions.bzl`. Per Hermeticity
Discussion #4 Gap 3, manifests applied from this repo are **vendored**
— `kubectl apply -f bootstrap.yaml` makes no network call at sync
time.

cert-manager is foundational across multiple platform components in
this milestone:

  • Capsule (#17) — webhook TLS via cert-manager Issuer + Certificate.
  • Temporal (#24) — temporal-operator's webhook TLS uses cert-manager.
  • Future workloads needing in-cluster TLS.

The pinned version (1.18.3) matches `rules_certmanager v0.1.2`'s
`CERT_MANAGER_VERSIONS` table. Pair-bumped with the rule package on
refresh so the Bazel toolchain (for #37 L4 testing) stays version-
aligned with the deployed manifest.

## Refresh procedure

```bash
VERSION=v1.18.3   # match rules_certmanager's pinned version
curl -sfL "https://github.com/cert-manager/cert-manager/releases/download/${VERSION}/cert-manager.yaml" \
    -o platform/cert-manager/bootstrap.yaml
```

| File | rules_certmanager | cert-manager version | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.1.2` | `v1.18.3` | `f12a78d93d77e1eb9dea0b6d7c931b26da287492fcdf0eb58620142883d4675a` | 990,715 |
