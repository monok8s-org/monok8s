# `platform/zitadel/` provenance

Two vendored manifests from rules_zitadel v0.3.0's bundled chart-renders
(Zitadel chart 9.34.0):

* `bootstrap.yaml` — Zitadel install configured against an external
  CloudNativePG cluster (the rule's `zitadel-cnpg.yaml` variant).
  Emits one Deployment + Jobs (zitadel-init / zitadel-setup /
  zitadel-cleanup) + Secrets + Service. Per AC#2, Postgres backend
  uses the platform CloudNativePG cluster (separate database per
  AC#3 from SpiceDB / Temporal).
* `cluster.yaml` — the per-Zitadel CNPG `Cluster` CR + bootstrap
  credentials Secret. Single instance for 0.1.0 demo mode (production
  hardens to N>=3 + tuned `postgresql.parameters` per workload, plus
  backups via `spec.backup`).

Per Hermeticity Discussion #4 Gap 3, manifests applied from this repo
are **vendored** — `kubectl apply -f *.yaml` makes no Helm fetch at
sync time. Pair-bumped with `rules_zitadel` in `MODULE.bazel` so the
in-tree Bazel toolchain (for #37 L4 testing) stays version-aligned
with the deployed manifest.

## Refresh procedure

Bump `rules_zitadel` in `MODULE.bazel`, then copy:

```bash
RZ_DIR=$(bazel info output_base)/external/rules_zitadel+
cp "$RZ_DIR/private/manifests/zitadel-cnpg.yaml" platform/zitadel/bootstrap.yaml
cp "$RZ_DIR/private/manifests/zitadel-db-cluster.yaml" platform/zitadel/cluster.yaml
```

| File | rules_zitadel | Zitadel chart | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.3.0` | `9.34.0` (CNPG variant) | `4f4d433220eb937e8d6c5cadc489fda4834313c65b60ed39cd2ae61938c977a6` | 20,919 |
| `cluster.yaml`   | `v0.3.0` | `9.34.0` (CNPG cluster CR) | `2cfe87bf5cb46242644630611587d54f38fe1f38fa6255dcc84cca37414a5432` | 1,691 |
