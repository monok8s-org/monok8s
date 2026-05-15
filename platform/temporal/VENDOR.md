# `platform/temporal/operator-bootstrap.yaml` provenance

Temporal operator install, vendored from rules_temporal v0.3.0's
bundled chart-render of `alexandrevilain/temporal-operator` v0.22.0.
The rule package concatenates upstream's two release assets
(`temporal-operator.crds.yaml` + `temporal-operator.yaml`) into a single
manifest at maintainer-render time. Per Hermeticity Discussion #4 Gap
3, manifests applied from this repo are **vendored** — `kubectl apply
-f operator-bootstrap.yaml` makes no network call at sync time.
Pair-bumped with `rules_temporal` in `MODULE.bazel` so the in-tree
Bazel toolchain (for #37 L4 testing) stays version-aligned with the
deployed manifest.

`rules_temporal v0.3.0` shipped two new install primitives in response
to [`rules_temporal#1`](https://github.com/collider-bazel-extensions/rules_temporal/issues/1):

* `temporal_install` — `kubectl_apply` over the bundled manifest. Drops
  into `itest_service.exe`; waits for the operator Deployment +
  4 consumer-facing CRDs (TemporalCluster, TemporalNamespace,
  TemporalSchedule, TemporalClusterClient).
* `temporal_install_health_check` — paired readiness probe.

Both are in the same package as the existing test primitives
(`temporal_test`, `temporal_server`, `temporal_workflow_history`,
`temporal_namespace_config`, `temporal_build`); the install primitives
are named with `_install_` to avoid colliding with the v0.1/v0.2
test-time `temporal_health_check`.

**cert-manager prerequisite**: the operator's manifest includes a
`Certificate` + `Issuer` CR for the admission webhook serving cert.
ArgoCD sync waves order this — `cert-manager` at wave 0 installs the
`cert-manager.io` CRDs first; the temporal Application at wave 2
applies these without rejection.

## Refresh procedure

Bump `rules_temporal` in `MODULE.bazel`, then copy:

```bash
RT_DIR=$(bazel info output_base)/external/rules_temporal+
cp "$RT_DIR/private/manifests/temporal_operator.yaml" \
    platform/temporal/operator-bootstrap.yaml
```

| File | rules_temporal | temporal-operator | sha256 | size |
|---|---|---|---|---|
| `operator-bootstrap.yaml` | `v0.3.0` | `v0.22.0` (CRDs + ops concatenated) | `a54cdac74a628e0149b29f8053a2282b711554466671a01a8a7d5347dd566b04` | 347,017 |
