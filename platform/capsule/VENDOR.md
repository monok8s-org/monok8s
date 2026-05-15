# `platform/capsule/bootstrap.yaml` provenance

Capsule's namespace-as-tenant operator manifest, vendored verbatim from
the rules_capsule v0.1.2 toolchain (which itself helm-renders the
upstream chart at the pinned tag). Per Hermeticity Discussion #4 Gap 3,
manifests applied from this repo are **vendored** — `kubectl apply -f
bootstrap.yaml` makes no Helm fetch at sync time. Pair-bumped with
`rules_capsule` in `MODULE.bazel` so the in-tree Bazel toolchain stays
version-aligned with the deployed manifest.

## Refresh procedure

Bump `rules_capsule` in `MODULE.bazel` first (the rule package bundles
the rendered manifest at `private/manifests/capsule-<version>.yaml`),
then copy that file here:

```bash
RC_VER=v0.1.2     # rules_capsule release
CAP_VER=0.10.4    # bundled Capsule version per rules_capsule's MODULE.bazel
RC_DIR=$(bazel info output_base)/external/rules_capsule+
cp "$RC_DIR/private/manifests/capsule-$CAP_VER.yaml" \
    platform/capsule/bootstrap.yaml
```

Capsule's webhook needs cert-manager (separate platform install). The
vendored manifest references cert-manager Issuer + Certificate resources
that get applied to the cluster only after cert-manager is up. ArgoCD
sync-waves on the Application order this dependency.

| File | rules_capsule | Capsule version | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.1.2` | `0.10.4` | `f6ee579854a0558d04e752302954fa6108b6e89e7fb659f2b13bd78c30050b57` | 457,547 |
