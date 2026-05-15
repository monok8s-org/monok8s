# `platform/opa/bootstrap.yaml` provenance

Gatekeeper's pre-rendered install manifest, fetched from the upstream
release tag and committed verbatim. Per Hermeticity Discussion #4 Gap 3,
manifests applied from this repo are **vendored** — `kubectl apply -f
bootstrap.yaml` makes no network call to upstream registries at sync time.

## Refresh procedure

```bash
VERSION=v3.22.2
curl -sfL "https://raw.githubusercontent.com/open-policy-agent/gatekeeper/${VERSION}/deploy/gatekeeper.yaml" \
    -o platform/opa/bootstrap.yaml
```

Record the version + sha256 + size below on every refresh.

| File | Gatekeeper version | sha256 | size |
|---|---|---|---|
| `bootstrap.yaml` | `v3.22.2` | `72683f57fdfa4c34d4a892e5e6f457a5a7e533eba0293d781d53d08dd6614a5a` | 260,814 |
