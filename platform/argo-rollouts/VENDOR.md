# `platform/argo-rollouts/bootstrap.yaml` provenance

Argo Rollouts controller install, vendored from rules_argo_rollouts
v0.1.0's bundled chart-render (Argo Rollouts Helm chart 2.40.9). Per
Hermeticity Discussion #4 Gap 3, manifests applied from this repo are
**vendored** — `kubectl apply -f bootstrap.yaml` makes no Helm fetch
at sync time. Pair-bumped with `rules_argo_rollouts` in `MODULE.bazel`
so the in-tree Bazel toolchain (for #37 L4 testing) stays version-
aligned with the deployed manifest.

## Refresh procedure

Bump `rules_argo_rollouts` in `MODULE.bazel`, then copy:

```bash
RAR_DIR=$(bazel info output_base)/external/rules_argo_rollouts+
cp "$RAR_DIR/private/manifests/argo_rollouts.yaml" \
    platform/argo-rollouts/bootstrap.yaml
```

| File | rules_argo_rollouts | Argo Rollouts chart | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `2.40.9` | `cc9b841827e1fc382d21308fb938e27eb502892bd2b8a4a68a08e34f401eba8f` | 1,065,962 |
