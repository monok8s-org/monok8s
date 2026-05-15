# monok8s on Bare Metal

Bare metal is the fourth supported host. The cluster runs on Talos Linux,
provisioned via Sidero Metal or by booting nodes from the Talos ISO.
Omni (Sidero Labs) is the recommended admin interface for cluster lifecycle.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| `talosctl` | ≥ 1.7 | `brew install siderolabs/tap/talosctl` |
| `kubectl` | ≥ 1.29 | `brew install kubectl` |
| `helm` | ≥ 3.14 | `brew install helm` |
| `crossplane` CLI | ≥ 1.15 | `brew install crossplane` |
| `zed` CLI | ≥ 0.14 | `brew install authzed/tap/zed` |

Hardware requirements (minimum):
- 3 nodes for control plane (HA etcd)
- 3+ worker nodes
- Each node: 4 vCPU, 16 GB RAM, 100 GB SSD
- Network: nodes reachable from each other on a flat L2 network
- One additional IP for the load balancer VIP (MetalLB)

---

## 1. Bootstrap the cluster (Talos)

Download the Talos ISO and boot all nodes from it:
```bash
# Generate machine configs
talosctl gen config monok8s-prod https://<control-plane-vip>:6443 \
  --output-dir ./talos-configs

# Apply config to each control plane node
talosctl apply-config --insecure --nodes <node1-ip> \
  --file talos-configs/controlplane.yaml

# Apply config to worker nodes
talosctl apply-config --insecure --nodes <worker1-ip> \
  --file talos-configs/worker.yaml

# Bootstrap etcd on the first control plane node
talosctl bootstrap --nodes <node1-ip> \
  --talosconfig talos-configs/talosconfig

# Get kubeconfig
talosctl kubeconfig --nodes <node1-ip> \
  --talosconfig talos-configs/talosconfig
```

---

## 2. Storage — Longhorn

Bare metal has no cloud PV provider. Longhorn provides replicated block storage:
```bash
helm upgrade --install longhorn longhorn/longhorn \
  --namespace longhorn-system --create-namespace \
  --set defaultSettings.defaultReplicaCount=3

# Set Longhorn as the default storage class
kubectl patch storageclass longhorn \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

---

## 3. Load balancer — MetalLB

Bare metal has no cloud load balancer. MetalLB provides `LoadBalancer` services:
```bash
helm upgrade --install metallb metallb/metallb \
  --namespace metallb-system --create-namespace

# Configure an IP address pool from your LAN range
kubectl apply -f - <<EOF
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: main
  namespace: metallb-system
spec:
  addresses:
    - 192.168.1.200-192.168.1.220   # adjust to your network
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: main
  namespace: metallb-system
EOF
```

---

## 4. Object storage — MinIO

Bare metal has no cloud object storage. MinIO provides S3-compatible storage.
CloudNativePG barman and Temporal archival use S3 — zero config changes needed.

```bash
helm upgrade --install minio minio/minio \
  --namespace minio --create-namespace \
  --set rootUser=admin \
  --set rootPassword=$(openssl rand -base64 24) \
  --set replicas=4 \
  --set persistence.storageClass=longhorn \
  --set persistence.size=500Gi \
  --set service.type=LoadBalancer

# Create buckets
mc alias set local http://<minio-lb-ip>:9000 admin <password>
mc mb local/monok8s-pgbackups
mc mb local/monok8s-temporal-archive
```

Update the CloudNativePG and Temporal configs to use the MinIO endpoint:
- In `platform/cloudnativepg/cluster.yaml`: change `destinationPath` to
  `s3://monok8s-pgbackups/app` and set `endpointURL` to `http://minio.minio:9000`
- In `platform/temporal/values-override.yaml`: update the S3 endpoint similarly

---

## 5. Install cluster add-ons

```bash
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

Apply Crossplane XRDs and the bare-metal-appropriate composition
(no cloud provider needed — Capsule namespace tenancy only):
```bash
kubectl apply -f infra/crossplane/xrds/
kubectl apply -f infra/crossplane/compositions/tenant-namespace/
```

---

## 6. SCIM identity federation

Bare metal installs have no cloud IAM to federate to. SCIM is optional:
- If users manage their own identity via Zitadel alone, skip this section.
- If the customer has an existing Entra ID or Google Workspace directory,
  configure SCIM as documented in `docs/install/azure.md` or `docs/install/gcp.md`.

---

## 7. Write-back

No cloud IAM means no write-back. The `platform/iam-writeback/` configs
and `apps/workers/iam-writeback/` worker are not deployed on bare metal.

---

## 8. Register with Model A (if this is a self-hosted install)

If this bare metal cluster is a **Model B** self-hosted deployment of monok8s,
register it with the Model A hosted service to receive:
- Centralized observability (metrics, logs, traces forwarded to Model A Grafana)
- Centralized alerting (operational alerts visible to your support team)
- Heartbeat monitoring (Model A alerts your support team if the cluster goes silent)

Follow the registration steps in `docs/install/model-b-registration.md`.

---

## 9. Verify

```bash
# Cluster health
kubectl get nodes
talosctl health --talosconfig talos-configs/talosconfig

# Storage
kubectl get nodes -o custom-columns=NAME:.metadata.name,STORAGE:.status.allocatable.storage
kubectl get pvc -A

# MetalLB assigned an IP to a LoadBalancer service
kubectl get svc -A | grep LoadBalancer

# MinIO accessible
mc ls local/

# CloudNativePG clusters running
kubectl get clusters -n monok8s-platform

# ArgoCD healthy
kubectl get applications -n argocd
```
