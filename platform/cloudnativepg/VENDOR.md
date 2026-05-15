# `platform/cloudnativepg/bootstrap.yaml` provenance

CloudNativePG operator install, vendored from rules_cloudnativepg
v0.1.0's bundled chart-render at chart 0.28.0. Per Hermeticity
Discussion #4 Gap 3, manifests applied from this repo are **vendored**
— `kubectl apply -f bootstrap.yaml` makes no Helm fetch at sync time.
Pair-bumped with `rules_cloudnativepg` in `MODULE.bazel` so the
in-tree Bazel toolchain stays version-aligned with the deployed
manifest.

CloudNativePG is foundational across multiple platform components in
this milestone:

  • SpiceDB (#23) backs its datastore with a CNPG `Cluster` CR.
  • Temporal (#24) backs history/matching/frontend persistence with
    a CNPG `Cluster` CR.
  • Per-tenant Postgres (tenant-namespace Composition, #14) emits a
    CNPG `Cluster` per onboarded tenant.

The operator is installed cluster-wide here; consumer manifests
(individual `Cluster` CRs) live alongside their owning components
under `platform/<component>/cluster.yaml` or in tenant Compositions.

## Refresh procedure

```bash
RC_DIR=$(bazel info output_base)/external/rules_cloudnativepg+
cp "$RC_DIR/private/manifests/cloudnativepg-<chart-version>.yaml" \
    platform/cloudnativepg/bootstrap.yaml
```

| File | rules_cloudnativepg | CNPG chart | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `0.28.0` | `0de8fbfb1ff9589d8efa8896cc2f6ccb975e62598a72ab697e3e20abb0d9d1e5` | 1,235,641 |
