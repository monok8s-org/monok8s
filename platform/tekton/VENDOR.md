# `platform/tekton/bootstrap.yaml` provenance

Tekton Pipelines install, vendored from rules_tekton v0.1.0's bundled
chart-render at Tekton Pipelines v1.11.1. Per Hermeticity Discussion
#4 Gap 3, manifests applied from this repo are **vendored** —
`kubectl apply -f bootstrap.yaml` makes no network call at sync time.
Pair-bumped with `rules_tekton` in `MODULE.bazel` so the in-tree
Bazel toolchain (for #37 L4 testing) stays version-aligned with the
deployed manifest.

The bundled manifest emits four Deployments across two namespaces:

* `tekton-pipelines/` — `tekton-pipelines-controller`,
  `tekton-pipelines-webhook`, `tekton-events-controller`.
* `tekton-pipelines-resolvers/` — `tekton-pipelines-remote-resolvers`
  (for `bundle:` / `git:` / `cluster:` taskRefs in the resolver-driven
  flow).

## Tekton Triggers — explicitly deferred

Per Discussion #3 §Per-layer scope: "Tekton: pipelines + tasks
installed; one pipeline wired (the api build). Webhook trigger
**deferred**." Triggers (TriggerTemplate / EventListener / etc.) are
not required for 0.1.0 — the first apps/api pipeline (#28) runs
manually for the milestone. Triggers install lands in 0.2.0 alongside
the production CI hookup.

## Refresh procedure

Bump `rules_tekton` in `MODULE.bazel`, then copy:

```bash
RT_DIR=$(bazel info output_base)/external/rules_tekton+
cp "$RT_DIR/private/manifests/tekton.yaml" platform/tekton/bootstrap.yaml
```

| File | rules_tekton | Tekton Pipelines | sha256 | size |
|---|---|---|---|---|
| `bootstrap.yaml` | `v0.1.0` | `v1.11.1` | `59bc95d327828a95a9e8fa550b30108886b736414e8f7e9271a4abd80d8b2adb` | 1,590,381 |
