# `platform/tempo/bootstrap.yaml` provenance

tempo install, vendored from rules_tempo v0.1.0's bundled chart-render. Per
Hermeticity Discussion #4 Gap 3, manifests applied from this repo are
**vendored** — `kubectl apply -f bootstrap.yaml` makes no Helm fetch
at sync time. Pair-bumped with `rules_tempo` in `MODULE.bazel` so the
in-tree Bazel toolchain (for #37 L4 testing) stays version-aligned with
the deployed manifest.

## Refresh procedure

```bash
RX_DIR=$(bazel info output_base)/external/rules_tempo+
cp "$RX_DIR/private/manifests/tempo.yaml" platform/tempo/bootstrap.yaml
```

| File | rules_tempo | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `2051c228eccabbdc86d954eaee8291490a1bb987e6a270c8103f29c4cb67bcf6` | 5845 |
