# `platform/keda/bootstrap.yaml` provenance

KEDA install, vendored from rules_keda v0.1.0's bundled chart-render.
Per Hermeticity Discussion #4 Gap 3, manifests applied from this repo
are **vendored** — `kubectl apply -f bootstrap.yaml` makes no Helm
fetch at sync time.

## Refresh procedure

```bash
RK_DIR=$(bazel info output_base)/external/rules_keda+
cp "$RK_DIR/private/manifests/keda.yaml" platform/keda/bootstrap.yaml
```

| File | rules_keda | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `4cf6815bdb738d39bec8f2bb49b63a41a8661d888b832dee5f37020a35c5b50c` | 774,645 |
