# apps/

Backend services. Each service owns its source code, BUILD targets, and K8s manifests.

## Language split

| Directory | Language | Why |
|---|---|---|
| `api/` | TypeScript (Node.js + tRPC) | tRPC is TypeScript-only; shares types with frontend |
| `workers/` | Go | Temporal Go SDK is the most mature; better suited for long-running processes |

Never use the Temporal Go SDK from the `api/` service.
Never use tRPC from workers — workers communicate via Temporal activities only.
Services do not call each other directly. Cross-service calls go via Temporal activities or the API.

## K8s manifests
Each service owns its manifests in `k8s/base/` and `k8s/overlays/`.
Never put service-level manifests in `platform/` — that directory is for cluster infrastructure only.

## Image naming convention
```
harbor.monok8s.internal/monok8s/<service-name>
```
Image tags are set by Tekton at build time via kustomize image patches in overlays.
Never hardcode a tag in a base manifest.

## Adding a new service
1. Create `apps/<name>/` with `src/`, `k8s/base/`, `k8s/overlays/{staging,prod,local}/`
2. Add `BUILD.bazel` with `app_image()` from `//tools/bazel:oci.bzl`
3. Add an ArgoCD `Application` CR in `platform/argocd/apps/`
4. Add a Vault policy in `platform/vault/policies/`
5. Add an `ExternalSecret` in `platform/external-secrets/`
6. Add `.env.local.template` for local dev
