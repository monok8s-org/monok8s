# `platform/mimir/bootstrap.yaml` provenance

mimir install, vendored from rules_mimir v0.1.0's bundled chart-render. Per
Hermeticity Discussion #4 Gap 3, manifests applied from this repo are
**vendored** — `kubectl apply -f bootstrap.yaml` makes no Helm fetch
at sync time. Pair-bumped with `rules_mimir` in `MODULE.bazel` so the
in-tree Bazel toolchain (for #37 L4 testing) stays version-aligned with
the deployed manifest.

## Refresh procedure

```bash
RX_DIR=$(bazel info output_base)/external/rules_mimir+
cp "$RX_DIR/private/manifests/mimir.yaml" platform/mimir/bootstrap.yaml
```

| File | rules_mimir | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `1ce3e549d7eb4412b3efbf599ca92b3108afca63a26f7fd6f25f1f1a3b6d984d` | 56095 |
