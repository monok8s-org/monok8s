# apps/telemetry-gateway/

Reverse proxy that authenticates Model B OTel Collectors and routes their
telemetry to Mimir, Loki, and Tempo with per-installation tenant isolation.

## Why a separate service

Mimir, Loki, and Tempo use the `X-Scope-OrgID` HTTP header for multi-tenancy.
The OTel Collector cannot inject dynamic per-request headers based on who sent
the data. The telemetry gateway solves this by:

1. Terminating mTLS (validates client cert against the installation CA)
2. Extracting the installation ID from the URL path (`/v1/<id>/...`)
3. Verifying the cert CN matches: `installation/<id>`
4. Injecting `X-Scope-OrgID: <id>` before proxying to the backend

## URL routing

| Path | Backend | Notes |
|---|---|---|
| `/v1/{id}/metrics` | Mimir `:9009/api/v1/push` | Prometheus remote_write |
| `/v1/{id}/logs` | Loki `:3100/loki/api/v1/push` | Loki push API |
| `/v1/{id}/otlp` | OTel Collector `:4318` | OTLP HTTP |

## Security invariants

- Client cert must be signed by the Vault PKI installation CA (`installation-ca-cert` secret)
- Cert CN must equal `installation/<installation_id>` — mismatch → 403
- TLS 1.3 minimum, ECDSA P-256 keys
- The gateway does not forward the client cert to backends (`X-Forwarded-Client-Cert` stripped)

## Cert rotation

Client certs are issued with 24h TTL. cert-manager on Model B renews at 20h via
the Vault issuer. The gateway uses the CA cert (not individual cert allowlists), so
rotation is transparent — no gateway config change needed on cert renewal.

The CA cert itself is long-lived (10 year). It is rotated via Vault PKI root rotation,
which requires updating the `installation-ca-cert` secret and rolling the gateway pods.

## Adding a new backend signal type

1. Add a new URL path case in `handleTelemetry` in `main.go`
2. Add the corresponding exporter in `platform/model-b/otel-collector-patch.yaml`
3. Document the new signal type in `docs/install/model-b-registration.md`
