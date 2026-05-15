# `platform/harbor/base/bootstrap.yaml` provenance

Harbor install, vendored from rules_harbor v0.1.0's bundled chart-render
(Harbor v2.13.x, `expose.type=clusterIP`). Per Hermeticity Discussion
#4 Gap 3, manifests applied from this repo are **vendored** —
`kubectl apply -f bootstrap.yaml` makes no Helm fetch at sync time.

The bundled chart-render emits Harbor with an internal `harbor-database`
StatefulSet (Bitnami `postgresql` subchart). Per AC#2 of #27, the
`base/cnpg-patches.yaml` strategic-merge patches override this:

* delete the `harbor-database` StatefulSet entirely (kustomize `$patch:
  delete`);
* re-point the `harbor-database` Service as an `ExternalName` alias for
  the per-Harbor CNPG `Cluster`'s `harbor-db-rw.harbor.svc` Service —
  Harbor's `POSTGRESQL_HOST: harbor-database` env var resolves via the
  ExternalName to the CNPG cluster transparently.

The per-Harbor CNPG `Cluster` lives at `cluster.yaml` (mirroring
SpiceDB's `cluster.yaml` from #23 + Temporal's from #24).

## Storage overlays per AC#3

* `overlays/baremetal/` — PVC-backed registry (default for kind +
  bare-metal Kubernetes); inherits the chart's PVC defaults.
* `overlays/gcp/` — GCS-backed registry; patches the registry component
  to use the `gcs` driver with a per-tenant bucket configured at deploy
  time.

ArgoCD `Application` defaults to `overlays/baremetal`; GKE deployments
re-target to `overlays/gcp`.

## Refresh procedure

```bash
RH_DIR=$(bazel info output_base)/external/rules_harbor+
cp "$RH_DIR/private/manifests/harbor.yaml" platform/harbor/base/bootstrap.yaml
```

| File | rules_harbor | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `4e84d918a1ff3fc5257c624a5b9178fbcc9367b09e7b80aae9b9bf92b18c53ef` | 45,472 |
