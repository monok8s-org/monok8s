# `platform/cilium/bootstrap.yaml` provenance

Cilium CNI install, vendored from rules_cilium v0.1.1's bundled
chart-render at Cilium v1.16.5. Per Hermeticity Discussion #4 Gap 3,
manifests applied from this repo are **vendored** — `kubectl apply -f
bootstrap.yaml` makes no Helm fetch at sync time.

## Refresh procedure

```bash
RC_DIR=$(bazel info output_base)/external/rules_cilium+
cp "$RC_DIR/private/manifests/cilium-<version>.yaml" \
    platform/cilium/bootstrap.yaml
```

| File | rules_cilium | Cilium version | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.1.1` | `1.16.5` | `00ee26478e42b3765d4132d5ed33d0e94ad66659d882bc00c569daa609a4ddf4` | 56,064 |
