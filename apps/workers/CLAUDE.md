# apps/workers/

Go Temporal workers. One directory per task queue / workflow domain.

## Temporal determinism — the most important rule in this directory

Workflow functions MUST be deterministic across replays. Temporal replays workflow
history to recover state after crashes — any non-determinism causes silent corruption.

**Banned inside workflow functions:**
- Direct I/O (DB calls, HTTP, filesystem)
- `time.Now()` → use `workflow.Now(ctx)` instead
- `rand` → use `workflow.SideEffect` if randomness is needed
- Goroutines or channels → use `workflow.Go` and `workflow.Channel`
- Global mutable state

**All side effects go in Activities, not Workflows:**
```go
// WRONG
func MyWorkflow(ctx workflow.Context, input Input) error {
    resp, err := http.Get("https://api.example.com")  // never
}

// RIGHT
func MyWorkflow(ctx workflow.Context, input Input) error {
    return workflow.ExecuteActivity(ctx, FetchDataActivity, input).Get(ctx, nil)
}
```

## Replay tests are mandatory
Every workflow must have a `replay_test` target (built via the upstream
`rules_temporal` `temporal_test` + `temporal_workflow_history` primitives)
with at least one recorded history. A workflow without a replay test is
not considered complete.

To record a history after running locally:
```bash
temporal workflow show -w <workflow-id> --output json > testdata/histories/<scenario>.json
```

## Activity conventions
- Always set `StartToCloseTimeout` — no activity runs unbounded
- Activities are retried automatically — make them idempotent
- Use `workflow.ActivityOptions` with appropriate retry policy per activity

## Worker/queue naming
Task queue name matches the worker directory name exactly:
- `apps/workers/onboarding/` → task queue `"onboarding"`
- `apps/workers/billing/`    → task queue `"billing"`

## KEDA scaling
Each worker has a `ScaledObject` in `platform/keda/`.
`minReplicaCount` must be >= 1 — cold start latency on queue arrival is unacceptable.
