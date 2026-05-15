# OnboardTenantWorkflow recorded histories

This directory will hold JSON workflow histories exported from a real
Temporal server run of `OnboardTenantWorkflow`. The
`//apps/workers/onboarding:replay_test` Bazel target replays each
committed history against the current workflow code via
`temporal workflow replay`, failing the build on any non-determinism
(per `apps/workers/CLAUDE.md`'s "replay tests are mandatory" rule).

## Status

**Empty as of #137 (#129b).** The `replay_test` target is wired but no
history file has been recorded yet — the workflow's activities all do
real I/O (NATS publish, k8s XR submit, Argo Workflow CR + NATS
callback), so recording requires either:

1. The L2 itest test driver from #138 (#129c), which runs the workflow
   end-to-end with the sidecar pattern (apiserver-watch +
   NATS-publish simulating Crossplane + Argo reconciles), capturing
   the history as a side effect; or
2. A standalone `record_history` binary with mocked activities, which
   would require either reversing the project's deliberate
   `package main` decision (`apps/workers/onboarding/BUILD.bazel:4-5`)
   or build-tag tricks.

The chosen path is (1) — `#129c` captures the first history.

## Recording recipe

When option (1) lands, the test driver in `#129c` writes:

```bash
# Inside the #129c Go test driver, after the workflow completes:
hist := c.GetWorkflowHistory(ctx, wfID, runID, false,
    enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
// Iterate + write JSON in the format `temporal workflow show -o json` produces.
```

The output committed here as `onboard_tenant_<scenario>.json`.

The equivalent manual recipe (operator-time, not used by CI):

```bash
# 1. Boot Temporal locally.
bazel run @rules_temporal//:temporal -- server start-dev

# 2. Build + start the worker (in another shell) — note: activities will
#    fail in this configuration without real backends; only viable once
#    a record_history binary with mocks exists.
TEMPORAL_ADDRESS=localhost:7233 bazel run //apps/workers/onboarding:worker

# 3. Submit a workflow.
bazel run @rules_temporal//:temporal -- workflow start \
    --task-queue onboarding \
    --type OnboardTenantWorkflow \
    --workflow-id record-acme-$(date +%s) \
    --input '{"TenantID":"acme","Email":"test@example.com","Plan":"free"}'

# 4. Dump history.
bazel run @rules_temporal//:temporal -- workflow show \
    -w <workflow-id> -o json > onboard_tenant_happy.json
```

## After a JSON lands

1. Commit it under this directory (`testdata/histories/`).
2. Update `apps/workers/onboarding/BUILD.bazel`:
   - Add a `temporal_workflow_history` target wrapping the JSON.
   - Change the `temporal_test :replay_test` target to add
     `history = ":histories"`.
3. `bazel test //apps/workers/onboarding:replay_test` then replays
   the committed history; any non-determinism regression in the
   workflow code fails the target.

## Naming convention

Per scenario: `onboard_tenant_<scenario>.json` (e.g.
`onboard_tenant_happy.json`, `onboard_tenant_step4_failure.json`).
The happy-path history is the minimum required for "the workflow has
a replay test." Additional failure-path histories are valuable for
verifying the compensation path stays deterministic too.
