# `platform/external-secrets/bootstrap.yaml` provenance

External Secrets Operator install, vendored from
rules_external_secrets v0.1.0's bundled chart-render. Per Hermeticity
Discussion #4 Gap 3, manifests applied from this repo are **vendored**
— `kubectl apply -f bootstrap.yaml` makes no Helm fetch at sync time.

The chart deploys three components: the operator + admission webhook +
cert-controller. ESO's CRDs (ExternalSecret, ClusterSecretStore,
SecretStore, ClusterExternalSecret, etc.) are installed at runtime as
the operator boots — consumers should poll on
`externalsecrets.external-secrets.io` before applying ESO CRs to avoid
racing the operator's CRD installer (per rules_external_secrets's
own README and the Crossplane-equivalent caveat in #58).

## Refresh procedure

```bash
RES_DIR=$(bazel info output_base)/external/rules_external_secrets+
cp "$RES_DIR/private/manifests/external_secrets.yaml" \
    platform/external-secrets/bootstrap.yaml
```

| File | rules_external_secrets | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `709e44a45b9e5d31e5bc156db8757fd76453f20495862b941d4f9b3dc73c14cc` | 1,799,861 |
