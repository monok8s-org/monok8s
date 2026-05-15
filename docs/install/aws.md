# monok8s on AWS (EKS)

AWS is the secondary host. The cluster runs on EKS.
Database backups already target S3 in the GCP config — on AWS that S3 bucket is local.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| `aws` CLI | ≥ 2.15 | `brew install awscli` |
| `eksctl` | ≥ 0.175 | `brew install eksctl` |
| `terraform` | ≥ 1.9 | `brew install terraform` |
| `kubectl` | ≥ 1.29 | `brew install kubectl` |
| `helm` | ≥ 3.14 | `brew install helm` |
| `crossplane` CLI | ≥ 1.15 | `brew install crossplane` |
| `zed` CLI | ≥ 0.14 | `brew install authzed/tap/zed` |

AWS account with these service quotas confirmed:
- EKS clusters: ≥ 1
- VPCs: ≥ 1 in target region
- IAM roles: sufficient headroom

---

## 1. Bootstrap (Terraform)

```bash
cd infra/terraform/environments/prod-aws
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Creates:
- EKS cluster (`monok8s-prod`, `us-east-1`, 3 nodes in managed node group)
- VPC with public/private subnets across 3 AZs
- IRSA (IAM Roles for Service Accounts) role for Crossplane
  (`arn:aws:iam::<account>:role/monok8s-crossplane-irsa`)
- IRSA role for the write-back worker
  (`arn:aws:iam::<account>:role/monok8s-iam-writeback-irsa`)
- S3 buckets: `monok8s-pgbackups`, `monok8s-temporal-archive`
- KMS key for S3 bucket encryption

State is stored in `s3://monok8s-tfstate-prod-aws/terraform/prod` with DynamoDB lock.

```bash
aws eks update-kubeconfig --name monok8s-prod --region us-east-1
```

---

## 2. Install cluster add-ons

```bash
# EBS CSI driver (required for PVCs)
eksctl create addon --name aws-ebs-csi-driver --cluster monok8s-prod \
  --service-account-role-arn arn:aws:iam::<account>:role/monok8s-ebs-csi-irsa

# Cert-manager
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set installCRDs=true

# Crossplane
helm upgrade --install crossplane crossplane-stable/crossplane \
  --namespace crossplane-system --create-namespace

# Capsule
helm upgrade --install capsule projectcapsule/capsule \
  --namespace capsule-system --create-namespace

# CloudNativePG
helm upgrade --install cnpg cloudnative-pg/cloudnative-pg \
  --namespace cnpg-system --create-namespace

# Vault
helm upgrade --install vault hashicorp/vault \
  --namespace vault --create-namespace

# External Secrets Operator
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace

# KEDA
helm upgrade --install keda kedacore/keda \
  --namespace keda --create-namespace

# ArgoCD
helm upgrade --install argocd argo/argo-cd \
  --namespace argocd --create-namespace
```

Annotate the Crossplane ServiceAccount with the IRSA role:
```bash
kubectl annotate serviceaccount crossplane \
  -n crossplane-system \
  eks.amazonaws.com/role-arn=arn:aws:iam::<account>:role/monok8s-crossplane-irsa
```

Apply Crossplane providers:
```bash
kubectl apply -f infra/crossplane/providers/provider-aws.yaml
kubectl wait --for=condition=healthy provider/provider-aws --timeout=120s
```

Apply XRDs and compositions:
```bash
kubectl apply -f infra/crossplane/xrds/
kubectl apply -f infra/crossplane/compositions/tenant-namespace/
kubectl apply -f infra/crossplane/compositions/tenant-aws/
```

---

## 3. SCIM identity federation

Zitadel pushes users and groups to **AWS IAM Identity Center** via SCIM 2.0.

### Enable IAM Identity Center

IAM Identity Center must be enabled in your AWS Organization (one-time per org):
```bash
aws sso-admin create-instance  # if not already enabled
```

Note the Instance ARN and Identity Store ID from the output.

### Configure automatic provisioning

In the IAM Identity Center console:
- **Settings → Identity source → Actions → Manage provisioning**
- Enable automatic provisioning
- Copy the **SCIM endpoint URL** and generate an **access token**
- Store in Vault: `vault kv put secret/monok8s/scim/aws endpoint=<url> token=<token>`

### Configure Zitadel to push to IAM Identity Center

In Zitadel admin console: **Integrations → SCIM → External targets → Add**
- Target URL: the SCIM endpoint from above
- Auth: Bearer token
- Resources to sync: users, groups

### Permission sets

The Terraform bootstrap creates one IAM Identity Center permission set per `TenantRole`
(except `owner`) named `monok8s-<role>`. These are projected onto per-tenant AWS accounts
by the Crossplane composition. Operators viewing the AWS Console SSO portal will see
role assignments matching SpiceDB.

### Verify SCIM sync
```bash
aws identitystore list-users \
  --identity-store-id <identity_store_id>
```

---

## 4. Workload Identity (IRSA)

Pod Identity / IRSA is configured by Terraform. Each service account is annotated with
its IRSA ARN in the Helm values or Kubernetes manifests.

Verify the Crossplane IRSA trust:
```bash
aws iam get-role --role-name monok8s-crossplane-irsa \
  --query 'Role.AssumeRolePolicyDocument'
# Should show a trust policy for sts:AssumeRoleWithWebIdentity
# from the EKS OIDC provider for crossplane-system/crossplane
```

---

## 5. Permission projection (Crossplane)

The AWS composition (`infra/crossplane/compositions/tenant-aws/`) provisions per-tenant:
- S3 bucket (`monok8s-tenant-<tenant_id>`) with SSE-KMS
- IAM Identity Center permission set assignments linking the SCIM-synced groups
  `monok8s-<tenant_id>-<role>` to their corresponding permission sets

Permission set assignments are reconciled on every Crossplane sync. No manual
AWS Console steps are needed after initial permission set creation (done by Terraform).

---

## 6. Write-back

CloudTrail audit events for IAM Identity Center role assignment changes are routed via
EventBridge → SQS → the write-back Temporal worker.

### Infrastructure

```bash
# Apply the EventBridge rule + SQS queue
kubectl apply -f platform/iam-writeback/aws/resources.yaml
```

This creates a Kubernetes `Job` that uses the AWS provider to manage:
- CloudTrail → EventBridge rule matching `sso:CreateAccountAssignment` and
  `sso:DeleteAccountAssignment` events
- SQS queue `monok8s-iam-writeback` (FIFO, 7-day retention, SSE-KMS)
- EventBridge target pointing at the SQS queue
- Dead-letter queue for failed deliveries

### Worker deployment

```bash
kubectl annotate serviceaccount iam-writeback-worker \
  -n iam-writeback \
  eks.amazonaws.com/role-arn=arn:aws:iam::<account>:role/monok8s-iam-writeback-irsa

kubectl apply -f apps/workers/iam-writeback/k8s/
kubectl apply -f platform/keda/iam-writeback.yaml
```

The KEDA `ScaledObject` scales the worker based on the SQS queue depth
(`monok8s-iam-writeback` approximate number of messages visible).

### Idempotency fence

The EventBridge rule includes an event pattern filter that excludes events where
`detail.userIdentity.sessionContext.sessionIssuer.userName` matches `monok8s-crossplane-irsa`.
This prevents Crossplane-originated role assignments from triggering a write-back loop.

See `platform/iam-writeback/aws/resources.yaml` for the exact filter pattern.

---

## 7. Register Model B installs (optional)

If customers self-host monok8s alongside your hosted service, they register their
installs to forward telemetry and alerts to Model A. See `docs/install/model-b-registration.md`.

## 8. Verify

```bash
# Cluster health
kubectl get nodes

# Crossplane providers healthy
kubectl get providers

# CloudNativePG clusters (app, SpiceDB, Temporal)
kubectl get clusters -n monok8s-platform

# SCIM: user count in IAM Identity Center
aws identitystore list-users --identity-store-id <id> --query 'length(Users)'

# Write-back worker running
kubectl get pods -n iam-writeback

# Backups: check the S3 bucket has WAL files
aws s3 ls s3://monok8s-pgbackups/app/ --recursive | head

# End-to-end write-back test:
# 1. In IAM Identity Center, assign monok8s-<tenant_id>-member permission set to a test user
# 2. Wait ~30s for EventBridge → SQS → worker → Temporal
# 3. Check SpiceDB: zed relationship read tenant:<tenant_id>#member
# 4. Verify write-back worker logs show the event was processed
```
