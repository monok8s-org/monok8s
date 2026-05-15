# `platform/vault/bootstrap.yaml` provenance

Vault dev-mode in-cluster install, vendored from rules_vault v0.2.0's
bundled chart-render (Vault Helm chart 0.32.0). Per Hermeticity
Discussion #4 Gap 3, manifests applied from this repo are **vendored** —
`kubectl apply -f bootstrap.yaml` makes no Helm fetch at sync time.

## Dev-mode caveats

This is **NOT** production-ready Vault. See Hermeticity Discussion #4
**Gap 5** for the explicit acceptance: dev-mode means single replica, no
HA, no auto-unseal, in-memory storage that resets on pod restart, no
audit log persistence. Acceptable for 0.1.0 demo path; production-
hardened Vault is its own milestone.

## Refresh procedure

Bump `rules_vault` in `MODULE.bazel`, then copy:

```bash
RV_DIR=$(bazel info output_base)/external/rules_vault+
cp "$RV_DIR/private/manifests/vault.yaml" platform/vault/bootstrap.yaml
```

For HA (production), use `vault-ha.yaml` from the same directory + a
new entry below — that's a 0.2.0+ task per Discussion #4 Gap 5.

| File | rules_vault | Vault chart version | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.2.0` | `0.32.0` (dev mode) | `f0ec6869dfd962f6571ce79a03e1e385ff7d3fa7d0c8984e36d93166c2b6f1ac` | 6,523 |
