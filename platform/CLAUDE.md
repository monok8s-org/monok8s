# platform/

K8s platform configuration. ArgoCD watches this directory and reconciles continuously.

## Simplification principle

Before adding a new tool or exporter, ask:
1. Does an existing tool already expose this signal natively? (prefer ServiceMonitor over a new exporter)
2. Does a community dashboard already exist? (import rather than build)
3. Does the new tool replace something already running? (remove the old one)
4. Can one operator manage multiple instances of the same thing? (CloudNativePG manages all Postgres clusters)

**Prefer: one operator, one pattern, many instances** over many operators doing similar things.

## What belongs here
Platform-level K8s resources that are not tied to a specific application service:
ArgoCD apps/appsets, Tekton pipelines and tasks, Vault policies and roles,
Cilium network policies and gateway config, KEDA ScaledObjects, OPA policies,
Capsule tenant templates, External Secrets, Grafana dashboards, OTel collector config.

## What does NOT belong here
- Application K8s manifests → `apps/<service>/k8s/`
- Tenant provisioning resources → `infra/crossplane/`
- Business logic of any kind → `apps/`

## Ownership boundaries

**ArgoCD**
- `argocd/apps/` — one `Application` CR per service
- `argocd/appsets/` — `ApplicationSet` for multi-service or multi-env patterns
- ArgoCD syncs manifests; it does not build images — that is Tekton's job
- Never put image tags directly in `Application` specs — use kustomize image patches in overlays

**Tekton**
- Tekton owns the production CI path: clone → test → build → push → update gitops
- GitHub Actions owns PR checks only
- Do not duplicate test logic between Tekton and GitHub Actions pipelines
- Tekton tasks are reusable units; pipelines compose them — keep tasks generic

**Argo Rollouts**
- Owns canary and blue-green deploy execution
- Kayenta provides automated canary analysis — do not remove analysis steps to speed up deploys
- Rollback is automatic on Kayenta failure — do not manually intervene during analysis window

**KEDA**
- ScaledObjects in `platform/keda/` target Temporal worker Deployments
- `minReplicaCount` must be >= 1 for all Temporal workers
- `targetQueueSize` is tuned per worker — check Grafana dashboard before changing

**Vault**
- Policies in `platform/vault/policies/` follow least-privilege — one policy per service
- Roles in `platform/vault/roles/` bind K8s ServiceAccounts to policies
- Dynamic database credentials (TTL-based) are preferred over static passwords

**Capsule**
- Tenant templates define resource quotas and network policy defaults
- Changes to tenant templates affect ALL tenants — test in staging first
