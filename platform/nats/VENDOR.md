# `platform/nats/bootstrap.yaml` provenance

NATS install, vendored from rules_nats v0.1.0's bundled chart-render
(`nats` Helm chart 2.12.6, `nats-server` 2.12.x). Per Hermeticity
Discussion #4 Gap 3, manifests applied from this repo are **vendored**
— `kubectl apply -f bootstrap.yaml` makes no Helm fetch at sync time.

JetStream is enabled in the rendered ConfigMap (`config/nats-values.yaml`
in rules_nats); single-replica StatefulSet at idle per Discussion #76
("floor-of-1 baseline; scales to 3-node cluster under load via the
rules_nats install operator").

## Refresh procedure

```bash
RN_DIR=$(bazel info output_base)/external/rules_nats+
cp "$RN_DIR/private/manifests/nats.yaml" platform/nats/bootstrap.yaml
```

| File | rules_nats | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `384d9fb2ef51122d50bb62a52110ed00c61daf154623636e7ca2083dda4eacd1` | 8,958 |
