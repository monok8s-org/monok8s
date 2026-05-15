# `platform/loki/bootstrap.yaml` provenance

loki install, vendored from rules_loki v0.1.0's bundled chart-render. Per
Hermeticity Discussion #4 Gap 3, manifests applied from this repo are
**vendored** — `kubectl apply -f bootstrap.yaml` makes no Helm fetch
at sync time. Pair-bumped with `rules_loki` in `MODULE.bazel` so the
in-tree Bazel toolchain (for #37 L4 testing) stays version-aligned with
the deployed manifest.

## Refresh procedure

```bash
RX_DIR=$(bazel info output_base)/external/rules_loki+
cp "$RX_DIR/private/manifests/loki.yaml" platform/loki/bootstrap.yaml
```

| File | rules_loki | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `2c376cb98bfe27be4d80cc232326af84c7ba44458f47f385cf8cf4342ca485d9` | 10217 |
