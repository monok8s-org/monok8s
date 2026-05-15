# Registering a Model B installation with Model A

A Model B install is a self-hosted monok8s deployment belonging to a tenant.
After registration, Model A receives:
- Metrics, logs, and traces (via mTLS OTel telemetry gateway)
- Operational alerts (via Alertmanager webhook)
- Heartbeats (every 5 minutes, drives health dashboard and missing-heartbeat alerts)

Identity is proved by a short-lived mTLS client certificate (24h TTL, auto-rotated
by cert-manager). A separate API key is used for the alert webhook and heartbeat
endpoint (longer-lived, rotatable by the tenant admin).

---

## Prerequisites

- Model B cluster is running and healthy (`kubectl get nodes`)
- cert-manager is installed on Model B
- The Model B cluster can reach `https://api.monok8s.io` and `https://telemetry.monok8s.io`
- You have `manage_settings` permission on the tenant in Model A

---

## Step 1 — Create the installation in Model A

In the Model A admin UI: **Settings → Installations → New Installation**

Or via the tRPC API:
```bash
curl -s -X POST https://api.monok8s.io/trpc/installations.register \
  -H "Authorization: Bearer <your_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"json":{"name":"prod-bare-metal","description":"On-prem cluster, DC1"}}'
```

Note the returned `installationId` and `bootstrapToken`. The bootstrap token is
shown **once** and expires in 1 hour.

---

## Step 2 — Supply the bootstrap token to Model B

Create the bootstrap secret on the Model B cluster:
```bash
kubectl create secret generic model-a-bootstrap \
  --from-literal=token=<bootstrap_token> \
  --from-literal=installation_id=<installation_id> \
  --from-literal=model_a_url=https://api.monok8s.io \
  -n monok8s-platform
```

Set `HOST_CLOUD` in `platform/model-b/registration-job.yaml` to one of:
`gcp`, `aws`, `azure`, `bare-metal`, `other`.

---

## Step 3 — Run the registration Job

```bash
kubectl apply -f platform/model-b/registration-job.yaml
kubectl wait --for=condition=complete job/model-a-registration \
  -n monok8s-platform --timeout=120s
kubectl logs job/model-a-registration -n monok8s-platform
```

On success the Job writes two secrets:
- `model-a-registration` — `INSTALLATION_ID`, `INSTALLATION_API_KEY`,
  `MODEL_A_API_URL`, `VAULT_ADDR`
- `installation-client-cert` — initial mTLS client cert (PEM)

---

## Step 4 — Apply Model B side configs

```bash
# OTel Collector: add Model A exporters
kubectl apply -f platform/model-b/otel-collector-patch.yaml

# cert-manager: takes over client cert rotation
kubectl apply -f platform/model-b/cert-rotation.yaml

# Alertmanager: add Model A webhook receiver
kubectl apply -f platform/model-b/alertmanager-patch.yaml

# Heartbeat CronJob (runs every 5 minutes)
kubectl apply -f platform/model-b/heartbeat-cronjob.yaml
```

---

## Step 5 — Verify

```bash
# Heartbeat appears in Model A within 5 minutes
# Check in Model A admin UI: Settings → Installations → <name> → Status: healthy

# Or via API:
curl -s https://api.monok8s.io/trpc/installations.get \
  -H "Authorization: Bearer <your_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"json":{"installationId":"<installation_id>"}}' \
  | jq '.result.data.heartbeatStatus'
# → "healthy"

# Verify telemetry is flowing in Model A Grafana:
# Explore → Mimir → {installation_id="<id>"} → should show cluster metrics
# Explore → Loki  → {installation_id="<id>"} → should show cluster logs

# Verify cert rotation is configured:
kubectl get certificate installation-client-cert -n monok8s-platform
# READY=True, expiry should be ~24h from now

# Delete the bootstrap secret — it's no longer needed
kubectl delete secret model-a-bootstrap -n monok8s-platform
```

---

## Revoking an installation

In the Model A admin UI: **Settings → Installations → <name> → Revoke**

Or via API:
```bash
curl -s -X POST https://api.monok8s.io/trpc/installations.revoke \
  -H "Authorization: Bearer <your_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"json":{"installationId":"<installation_id>"}}'
```

Revocation immediately:
1. Adds the client cert to the Vault PKI CRL (telemetry-gateway rejects it)
2. Removes SpiceDB relations (API key calls return 403)
3. Stops the HeartbeatMonitorWorkflow
4. Marks the DB record as revoked

On Model B, remove the side configs and secrets:
```bash
kubectl delete -f platform/model-b/
kubectl delete secret model-a-registration installation-client-cert -n monok8s-platform
```

---

## Rotating the API key

The API key (used for heartbeat and alert webhook) can be rotated without
affecting the mTLS cert or re-registering the installation.

In the Model A admin UI: **Settings → Installations → <name> → Rotate Key**

Update Model B after rotation:
```bash
# Update the registration secret with the new key
kubectl patch secret model-a-registration -n monok8s-platform \
  --type=merge \
  -p '{"stringData":{"INSTALLATION_API_KEY":"<new_key>"}}'
# CronJob and Alertmanager pick up the new key on next execution
```
