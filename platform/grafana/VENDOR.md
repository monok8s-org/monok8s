# `platform/grafana/bootstrap.yaml` provenance

Grafana install, vendored from rules_grafana v0.1.0's bundled chart-
render. Per Hermeticity Discussion #4 Gap 3, manifests applied from
this repo are **vendored** — `kubectl apply -f bootstrap.yaml` makes
no Helm fetch at sync time. Pair-bumped with `rules_grafana` in
`MODULE.bazel`.

The Grafana chart's sidecar discovery picks up:

* `ConfigMap`s labeled `grafana_datasource=1` for datasource provisioning
  → see `datasources.yaml` (Loki + Mimir + Tempo wired).
* `ConfigMap`s labeled `grafana_dashboard=1` for dashboard import
  → see `dashboards/temporal-worker.yaml` (vendored Temporal SDK
  dashboard, AC#4) + `dashboards/onboard-tenant.yaml` (custom
  OnboardTenant dashboard, AC#5).

| File | rules_grafana | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `6ca44c4bc70c908add6d9f8e84c7d3a2ab3fa649a60872d81b22db252eea3c0f` | 7,416 |
