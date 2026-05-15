# monok8s on Azure (AKS)

Azure is the tertiary host. The cluster runs on AKS.
Zitadel integrates with Entra ID (formerly Azure AD) as the SCIM target.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| `az` CLI | ≥ 2.58 | `brew install azure-cli` |
| `terraform` | ≥ 1.9 | `brew install terraform` |
| `kubectl` | ≥ 1.29 | `brew install kubectl` |
| `helm` | ≥ 3.14 | `brew install helm` |
| `crossplane` CLI | ≥ 1.15 | `brew install crossplane` |
| `zed` CLI | ≥ 0.14 | `brew install authzed/tap/zed` |

Azure subscription with these resource providers registered:
```bash
az provider register --namespace Microsoft.ContainerService
az provider register --namespace Microsoft.ManagedIdentity
az provider register --namespace Microsoft.Storage
az provider register --namespace Microsoft.KeyVault
az provider register --namespace Microsoft.EventGrid
az provider register --namespace Microsoft.ServiceBus
az provider register --namespace Microsoft.Authorization
```

---

## 1. Bootstrap (Terraform)

```bash
cd infra/terraform/environments/prod-azure
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Creates:
- Resource group `monok8s-prod`
- AKS cluster (`monok8s-prod`, `eastus`, 3 nodes in system node pool)
- Virtual network + subnets
- User-assigned managed identity for Crossplane
  (`monok8s-crossplane` in resource group `monok8s-prod`)
- User-assigned managed identity for write-back worker
  (`monok8s-iam-writeback` in resource group `monok8s-prod`)
- Azure Key Vault for secrets (Vault backend on Azure)
- Storage account `monok8sprod` (for Terraform state)

Terraform state stored in Azure Blob Storage:
`monok8s-tfstate` container, `prod/terraform.tfstate`.

```bash
az aks get-credentials --resource-group monok8s-prod --name monok8s-prod
```

---

## 2. Install cluster add-ons

```bash
# Enable AKS workload identity (required for managed identity federation)
az aks update --resource-group monok8s-prod --name monok8s-prod \
  --enable-workload-identity --enable-oidc-issuer

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

# Vault (or use Azure Key Vault directly)
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

Federate the Crossplane ServiceAccount with the managed identity:
```bash
OIDC_ISSUER=$(az aks show -g monok8s-prod -n monok8s-prod \
  --query oidcIssuerProfile.issuerUrl -o tsv)

az identity federated-credential create \
  --name crossplane-federated \
  --identity-name monok8s-crossplane \
  --resource-group monok8s-prod \
  --issuer "$OIDC_ISSUER" \
  --subject "system:serviceaccount:crossplane-system:crossplane"

kubectl annotate serviceaccount crossplane -n crossplane-system \
  azure.workload.identity/client-id=$(az identity show \
    --name monok8s-crossplane --resource-group monok8s-prod \
    --query clientId -o tsv)
```

Apply Crossplane providers:
```bash
kubectl apply -f infra/crossplane/providers/provider-azure.yaml
kubectl wait --for=condition=healthy provider/provider-azure --timeout=120s
```

Apply XRDs and compositions:
```bash
kubectl apply -f infra/crossplane/xrds/
kubectl apply -f infra/crossplane/compositions/tenant-namespace/
kubectl apply -f infra/crossplane/compositions/tenant-azure/
```

---

## 3. SCIM identity federation

Zitadel pushes users and groups to **Azure Entra ID** via SCIM 2.0.
Entra ID is configured as an Enterprise Application receiving provisioning from Zitadel.

### Register monok8s as an Entra Enterprise Application

```bash
# Create the app registration
APP_ID=$(az ad app create \
  --display-name "monok8s" \
  --query appId -o tsv)

# Create service principal
az ad sp create --id $APP_ID

# Add app roles matching TenantRole (one per role)
for ROLE in admin member viewer billing_manager; do
  az ad app update --id $APP_ID \
    --app-roles "[{\"displayName\":\"monok8s:$ROLE\",\"value\":\"monok8s:$ROLE\",
      \"id\":\"$(uuidgen)\",\"isEnabled\":true,
      \"allowedMemberTypes\":[\"User\",\"Group\"]}]"
done
```

### Configure SCIM provisioning

In Entra ID admin console: **Enterprise applications → monok8s → Provisioning**
- Provisioning mode: **Automatic**
- Admin credentials:
  - Tenant URL: `https://zitadel.<your-domain>/scim/v2`
  - Secret token: from Vault `secret/data/monok8s/scim/azure`
- Mappings: sync users and groups

In Zitadel: **Integrations → SCIM → External targets → Add**
- Target URL: Entra provisioning SCIM endpoint
- Auth: Bearer token from Entra provisioning credentials

### Verify SCIM sync
```bash
az ad user list --filter "startswith(displayName,'monok8s')" --query '[].displayName'
```

---

## 4. Workload Identity (Azure Federated Identity)

AKS Workload Identity is configured in step 2. Each service account that needs
Azure API access has a federated credential created at bootstrap.

Verify the write-back worker managed identity is federated:
```bash
az identity federated-credential list \
  --identity-name monok8s-iam-writeback \
  --resource-group monok8s-prod
```

The write-back managed identity requires:
```bash
# Read Activity Logs
az role assignment create \
  --assignee $(az identity show --name monok8s-iam-writeback \
    -g monok8s-prod --query principalId -o tsv) \
  --role "Monitoring Reader" \
  --scope /subscriptions/<subscription_id>

# Receive from Service Bus
az role assignment create \
  --assignee <principal_id> \
  --role "Azure Service Bus Data Receiver" \
  --scope /subscriptions/<subscription_id>/resourceGroups/monok8s-prod/providers/Microsoft.ServiceBus/namespaces/monok8s
```

---

## 5. Permission projection (Crossplane)

The Azure composition (`infra/crossplane/compositions/tenant-azure/`) provisions per-tenant:
- Azure Storage container (within the `monok8sprod` storage account)
- Entra ID group `monok8s-<tenant_id>-<role>` for each tenant role
- App role assignment linking the Entra group to the monok8s Enterprise Application

App role assignments are visible in the Azure portal under:
**Enterprise applications → monok8s → Users and groups**

---

## 6. Write-back

Azure Activity Log events for role assignment changes are routed via
Event Grid → Service Bus → the write-back Temporal worker.

### Infrastructure

```bash
kubectl apply -f platform/iam-writeback/azure/resources.yaml
```

This creates (via Crossplane Azure provider):
- Service Bus namespace `monok8s` + queue `iam-writeback`
- Event Grid system topic subscribed to `Microsoft.Authorization/roleAssignments/write`
  and `Microsoft.Authorization/roleAssignments/delete` events at subscription scope
- Event Grid event subscription delivering to the Service Bus queue

### Worker deployment

```bash
WRITEBACK_CLIENT_ID=$(az identity show \
  --name monok8s-iam-writeback -g monok8s-prod --query clientId -o tsv)

kubectl annotate serviceaccount iam-writeback-worker -n iam-writeback \
  azure.workload.identity/client-id=$WRITEBACK_CLIENT_ID

kubectl apply -f apps/workers/iam-writeback/k8s/
kubectl apply -f platform/keda/iam-writeback.yaml
```

KEDA scales based on the Service Bus queue active message count.

### Idempotency fence

The Event Grid subscription includes an advanced filter excluding events where
`data.claims.appid` equals the Crossplane managed identity's client ID.
This prevents the write-back loop for Crossplane-originated role assignments.

See `platform/iam-writeback/azure/resources.yaml` for the filter expression.

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

# CloudNativePG clusters
kubectl get clusters -n monok8s-platform

# Managed identity federation working
kubectl run test-identity --image=mcr.microsoft.com/azure-cli --rm -it -- \
  az account show  # should use workload identity, not fail

# SCIM: check user count in Entra
az ad user list --query 'length(@)'

# Write-back worker running
kubectl get pods -n iam-writeback

# End-to-end write-back test:
# 1. In Entra admin portal, assign monok8s:member app role to a test user for a tenant group
# 2. Wait ~30s for Event Grid → Service Bus → worker → Temporal
# 3. Check SpiceDB: zed relationship read tenant:<tenant_id>#member
# 4. Verify write-back worker logs show the event was processed
```
