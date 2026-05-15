# apps/workers/iam-writeback/

Temporal worker that reconciles cloud IAM role assignment changes back into SpiceDB.
Runs on task queue `"iam-writeback"`.

## Architecture

```
Cloud audit log
  → Cloud message queue (SQS / Service Bus / Pub/Sub)
    → consumer_{aws,azure,gcp}.go  (polls queue, starts Temporal workflow)
      → IAMWritebackWorkflow (workflow.go)
        → ValidateSubjectActivity  — checks subject exists in monok8s
        → WriteSpiceDBActivity     — writes granted/revoked relation
        → RevertCloudAssignmentActivity  — removes unknown cloud assignments
        → WriteAuditEventActivity  — appends tenant_membership_events row
```

## SpiceDB is canonical

Cloud IAM is a projection of SpiceDB state, not the source of truth.
If a cloud assignment references a principal that doesn't exist in monok8s, the
workflow reverts the assignment (best-effort) and logs the incident.
Crossplane's reconciliation loop also corrects cloud state on every sync cycle.

## Idempotency fence

Events originating from Crossplane are filtered at two levels:

1. **Cloud layer** — EventBridge rule / Event Grid filter / Log Sink exclusion
   filters out the Crossplane service principal before messages reach the queue.
   See `platform/iam-writeback/{aws,azure,gcp}/resources.yaml`.

2. **Worker layer** — `consumer_*.go` re-checks `OriginatedByMonok8s` before
   starting the workflow. Belt-and-suspenders in case the cloud filter changes.

Never remove either fence independently.

## Role name convention

Cloud roles embed both the resource type and the role name so that new resource
types (e.g. `installation`) work automatically without modifying `translate.go`.

| Cloud | Format | Example |
|---|---|---|
| AWS permission set | `monok8s-<resource-type>-<role>` | `monok8s-tenant-admin` |
| Azure app role value | `monok8s:<resource-type>:<role>` | `monok8s:tenant:viewer` |
| GCP custom role ID | `monok8s_<resource_type>_<role>_<resource_id>` | `monok8s_tenant_member_550e8400-...` |

The resource ID is carried via account tags / Entra group name / GCP bucket labels
for AWS and Azure; for GCP it is embedded in the role ID (hyphens replaced with
underscores because GCP role IDs may not contain hyphens).

The `translate.go` file contains the extraction functions. `owner` is deliberately
absent from all cloud role names — the owner role cannot be assigned via cloud IAM.

Adding support for a new resource type requires only:
1. Creating the Crossplane composition with the standard tag set
   (`monok8s.io/resource-type`, `monok8s.io/resource-id`)
2. Creating cloud roles/groups that follow the naming convention above
No changes to `translate.go` are needed.

## Principal ID resolution

Cloud principals (Identity Store user ID, Entra object ID, GCP email) must be
resolved to monok8s UUIDs. The mapping is maintained in `user_snapshots.zitadel_id`
(Zitadel user ID, which matches the SCIM external ID used by all three clouds).

The TODO stubs in consumer files mark where this lookup should be implemented.

## KEDA scaling

Scaled by queue depth — see `platform/keda/iam-writeback.yaml`.
Only the ScaledObject matching the active host cloud should be applied.
`minReplicaCount: 1` — the worker must always be available for security-critical events.
