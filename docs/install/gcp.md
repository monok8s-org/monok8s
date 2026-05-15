# monok8s on GCP (GKE)

GCP is the reference host. All platform components were designed here first.
The cluster runs on GKE; backups target AWS S3 (intentional multi-cloud — see below).

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| `gcloud` | ≥ 480 | `brew install google-cloud-sdk` |
| `terraform` | ≥ 1.9 | `brew install terraform` |
| `kubectl` | ≥ 1.29 | `gcloud components install kubectl` |
| `helm` | ≥ 3.14 | `brew install helm` |
| `crossplane` CLI | ≥ 1.15 | `brew install crossplane` |
| `zed` CLI | ≥ 0.14 | `brew install authzed/tap/zed` |

GCP project with these APIs enabled:
```bash
gcloud services enable \
  container.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  cloudidentity.googleapis.com \
  cloudaudit.googleapis.com \
  pubsub.googleapis.com
```

---

## 1. Bootstrap (Terraform)

```bash
cd infra/terraform/environments/prod
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Creates:
- GKE cluster (`monok8s-prod`, `us-central1`, 3 nodes)
- VPC + subnets
- IAM service account for Crossplane (`crossplane@<project>.iam.gserviceaccount.com`)
  with Workload Identity binding to `crossplane-system/crossplane`
- IAM service account for write-back listener (`iam-writeback@<project>.iam.gserviceaccount.com`)

State is stored in `gs://monok8s-tfstate-prod/terraform/prod`.

```bash
gcloud container clusters get-credentials monok8s-prod --region us-central1
```

---

## 2. Install cluster add-ons

Install in order (ArgoCD last — it takes over sync after this point):

```bash
# Cert-manager
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --set installCRDs=true

# Crossplane
helm upgrade --install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system --create-namespace

# Capsule
helm upgrade --install capsule projectcapsule/capsule \
  --namespace capsule-system --create-namespace

# CloudNativePG
helm upgrade --install cnpg cloudnative-pg/cloudnative-pg \
  --namespace cnpg-system --create-namespace

# Vault (or use HCP Vault)
helm upgrade --install vault hashicorp/vault \
  --namespace vault --create-namespace

# External Secrets Operator
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace

# KEDA
helm upgrade --install keda kedacore/keda \
  --namespace keda --create-namespace

# ArgoCD (takes over GitOps from here)
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd --create-namespace
```

Apply Crossplane providers:
```bash
kubectl apply -f infra/crossplane/providers/provider-gcp.yaml
kubectl wait --for=condition=healthy provider/provider-gcp --timeout=120s
```

Apply XRDs and compositions:
```bash
kubectl apply -f infra/crossplane/xrds/
kubectl apply -f infra/crossplane/compositions/tenant-namespace/
kubectl apply -f infra/crossplane/compositions/tenant-gcp/
```

---

## 3. SCIM identity federation

Zitadel pushes users and groups to **Google Cloud Identity** via SCIM 2.0.
Changes in Zitadel (new users, group changes) propagate to Cloud Identity within the
SCIM sync interval (default: 10 minutes).

### Configure Zitadel as a SCIM provider

1. In Zitadel admin console: **Integrations → SCIM** → Enable SCIM server
2. Generate a SCIM API token (store in Vault at `secret/data/monok8s/scim/gcp`)
3. In Google Admin Console: **Directory → Directory settings → External directory sync**
   - SCIM URL: `https://zitadel.<your-domain>/scim/v2`
   - Auth: Bearer token (from step 2)
   - Enable provisioning: users + groups

### Group → Cloud Identity group mapping

Groups named `monok8s-{tenant_id}-{role}` in Zitadel are synced as Cloud Identity
groups. These groups are referenced in the Crossplane GCP composition for IAM bindings.

### Verify SCIM sync
```bash
# List synced users in Cloud Identity
gcloud identity groups list --customer=<customer_id>
```

---

## 4. Workload Identity

GKE Workload Identity is configured by Terraform. Per-service bindings:

```bash
# Verify Crossplane SA binding
gcloud iam service-accounts get-iam-policy \
  crossplane@<project>.iam.gserviceaccount.com
# Should show: roles/iam.workloadIdentityUser for crossplane-system/crossplane

# Verify write-back worker SA binding
gcloud iam service-accounts get-iam-policy \
  iam-writeback@<project>.iam.gserviceaccount.com
# Should show: roles/iam.workloadIdentityUser for iam-writeback/iam-writeback-worker
```

The write-back worker SA requires:
```bash
gcloud projects add-iam-policy-binding <project> \
  --member="serviceAccount:iam-writeback@<project>.iam.gserviceaccount.com" \
  --role="roles/logging.viewer"   # read Cloud Audit Logs

gcloud projects add-iam-policy-binding <project> \
  --member="serviceAccount:iam-writeback@<project>.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"
```

---

## 5. Permission projection (Crossplane)

The GCP composition (`infra/crossplane/compositions/tenant-gcp/`) provisions per-tenant:
- GCS bucket for tenant object storage
- Custom IAM roles mirroring `TenantRole` (named `projects/<project>/roles/monok8s.<role>`)
- IAM policy bindings on the tenant GCS bucket for each role

When a tenant is onboarded via `OnboardTenantWorkflow`, Crossplane reconciles these
resources automatically. No manual steps needed.

Verify a tenant's GCP resources after onboarding:
```bash
# Bucket
gsutil ls gs://monok8s-tenant-<tenant_id>/

# IAM bindings on bucket
gsutil iam get gs://monok8s-tenant-<tenant_id>/
```

---

## 6. Write-back

Write-back lets operators assign roles in the GCP Console or `gcloud` and have those
changes reflected in monok8s SpiceDB. SpiceDB remains canonical — conflicting state
is detected and the GCP change is reverted if it has no corresponding monok8s principal.

### Infrastructure

Apply the Pub/Sub subscription that feeds the write-back worker:
```bash
kubectl apply -f platform/iam-writeback/gcp/resources.yaml
```

This creates:
- Pub/Sub topic `monok8s-iam-events`
- Log sink routing `cloudaudit.googleapis.com/activity` events matching IAM role
  assignment changes to the topic
- Pub/Sub subscription `monok8s-iam-writeback` (pull, 7-day retention)

### Worker deployment

The write-back worker runs in the `iam-writeback` namespace and uses Workload Identity
to pull from the Pub/Sub subscription:
```bash
kubectl apply -f apps/workers/iam-writeback/k8s/
kubectl apply -f platform/keda/iam-writeback.yaml
```

### Idempotency fence

Changes made by Crossplane (originating from SA `crossplane@<project>.iam.gserviceaccount.com`)
are filtered out at the Log Sink level via an exclusion filter — they do not reach Pub/Sub.
This prevents the write-back loop:
```
SpiceDB write → Crossplane → GCP IAM change → Pub/Sub → write-back → SpiceDB (duplicate)
```

The exclusion filter is defined in `platform/iam-writeback/gcp/resources.yaml`.

---

## 7. Database backups

CloudNativePG backs up to AWS S3 (`s3://monok8s-pgbackups/`). This is intentional:
durable data survives a full GCP region outage.

The S3 credentials live in `pg-backup-secrets` (Vault → ESO). Verify:
```bash
kubectl get secret pg-backup-secrets -n monok8s-platform -o yaml
```

---

## 8. Register Model B installs (optional)

If customers self-host monok8s alongside your hosted service, they register their
installs to forward telemetry and alerts to Model A. See `docs/install/model-b-registration.md`.

## 9. Verify

```bash
# Cluster health
kubectl get nodes

# Crossplane providers healthy
kubectl get providers

# CloudNativePG clusters running
kubectl get clusters -n monok8s-platform

# SpiceDB schema applied
zed schema read --endpoint $SPICEDB_ENDPOINT --token $SPICEDB_TOKEN

# SCIM sync: check a test user appears in Cloud Identity
gcloud identity groups memberships list --group-email=<group>@<domain>

# Write-back worker running
kubectl get pods -n iam-writeback

# End-to-end: assign a GCP IAM role manually and verify it appears in SpiceDB
# (See write-back runbook in docs/runbooks/iam-writeback.md)
```
