# infra/

Infrastructure as code. Hard split between Terraform (bootstrap) and Crossplane (runtime).

## The boundary

```
terraform/    Runs ONCE. Provisions foundational cloud resources before the cluster exists.
crossplane/   Runs forever. Continuously reconciles tenant-facing resources inside the cluster.
```

**If it exists before the first tenant onboards → Terraform.**
**If it is created per-tenant or changes at runtime → Crossplane.**

Examples:
| Resource | Owner | Why |
|---|---|---|
| GKE cluster | Terraform | Exists before Crossplane can run |
| VPC / subnets | Terraform | Foundational networking |
| IAM roles for Crossplane | Terraform | Crossplane needs these to provision anything |
| Tenant Postgres database | Crossplane | Created per-tenant at onboarding |
| Tenant namespace (Capsule) | Crossplane | Created per-tenant at onboarding |
| Tenant S3/GCS bucket | Crossplane | Created per-tenant at onboarding |

## Terraform conventions
- Never run `terraform apply` against a live environment without an explicit plan review
- State lives in a remote backend (GCS bucket) — never commit `.tfstate`
- Modules in `terraform/modules/` are reusable across environments
- `terraform/environments/{staging,prod}/` contain the environment-specific root modules

## Multi-cloud layout

Each supported host has its own Terraform environment and Crossplane composition:

| Cloud | Terraform env | Crossplane composition | Install doc |
|---|---|---|---|
| GCP (GKE) | `environments/prod/` | `compositions/tenant-gcp/` | `docs/install/gcp.md` |
| AWS (EKS) | `environments/prod-aws/` | `compositions/tenant-aws/` | `docs/install/aws.md` |
| Azure (AKS) | `environments/prod-azure/` | `compositions/tenant-azure/` | `docs/install/azure.md` |

Terraform modules are in `modules/cluster/` (GCP), `modules/cluster-aws/`, `modules/cluster-azure/`.
Only one environment is active in production at a time. The `tenant-namespace` composition
(Capsule) is cloud-agnostic and applies on all hosts alongside the cloud-specific composition.

## Crossplane conventions
- One XRD per logical resource type (`XTenant`, `XTenantDatabase`, etc.)
- Compositions must be idempotent — Crossplane reconciles on every change
- Derive child resource names from composite spec fields via patches — never hardcode
- Compositions live in `compositions/<resource-type>/composition.yaml`
- XRDs (the CRD definitions) live in `xrds/`
- Tenant provisioning is triggered by the Temporal onboarding workflow, not manually
