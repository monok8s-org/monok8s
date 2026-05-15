# `platform/otel/bootstrap.yaml` provenance

otel install, vendored from rules_otel v0.1.0's bundled chart-render. Per
Hermeticity Discussion #4 Gap 3, manifests applied from this repo are
**vendored** — `kubectl apply -f bootstrap.yaml` makes no Helm fetch
at sync time. Pair-bumped with `rules_otel` in `MODULE.bazel` so the
in-tree Bazel toolchain (for #37 L4 testing) stays version-aligned with
the deployed manifest.

## Refresh procedure

```bash
RX_DIR=$(bazel info output_base)/external/rules_otel+
cp "$RX_DIR/private/manifests/otel.yaml" platform/otel/bootstrap.yaml
```

| File | rules_otel | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `9920fbb7a5655702d7791241adab180045c27352a32ab85846a37d6f44c93a00` | 6657 |
