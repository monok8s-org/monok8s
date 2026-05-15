# apps/workers/access-review/

Temporal worker for periodic access recertification and cloud-native access review
integration. Runs on task queue `"access-review"`.

## What this worker does

Two distinct but related workflows:

**1. Internal access review (`AccessReviewWorkflow`)**
- Finds all tenant role assignments older than 90 days without a recent review
- Notifies tenant owner(s) via email with a review deadline (14 days)
- Listens for review decisions via the `review-decision` Temporal signal
- Auto-revokes non-responses (deny-by-default) when the deadline passes
- Writes all decisions to `access_review_decisions` for compliance evidence

**2. Cloud-native findings (`CloudAccessReviewWorkflow`)**
- AWS: fetches IAM Access Analyzer findings on monok8s-tagged resources
- Azure: fetches completed Entra ID Access Review decisions
- GCP: fetches IAM Recommender suggestions for monok8s custom roles
- Reconciles findings against SpiceDB; orphaned cloud assignments are logged
  as incidents and cleaned up by the write-back revert path

## Schedule

Both workflows run quarterly. See `platform/access-review/schedule.yaml`.

The internal access review runs first (first week of each quarter).
Cloud-native reviews run in the following week after cloud portals have had
time to process the previous quarter's activity.

## Compliance mapping

| Workflow | Control |
|---|---|
| `AccessReviewTenantWorkflow` | SOC 2 CC6.3, ISO 27001 A.9.2.5 |
| `CloudAccessReviewWorkflow` (AWS) | SOC 2 CC6.6 (external access) |
| `CloudAccessReviewWorkflow` (Azure) | SOC 2 CC6.3, ISO 27001 A.9.2.5 |
| `CloudAccessReviewWorkflow` (GCP) | SOC 2 CC6.3 (least privilege) |

Evidence for auditors: export `access_review_decisions` table filtered by
review quarter.

## Signal flow for UI-driven decisions

The monok8s frontend settings page (`/settings/access-review`) calls the
`reviewDecision` tRPC mutation, which signals the Temporal workflow:

```
User clicks Confirm/Revoke
  → POST /trpc/accessReview.decide
    → ctx.temporal.signal(workflowId, "review-decision", decision)
      → AccessReviewTenantWorkflow receives decision
        → writes audit record
        → (if revoked) RevokeAssignmentActivity → SpiceDB
```

## Auto-revocation and Crossplane reconciliation

When `RevokeAssignmentActivity` removes a relationship from SpiceDB, Crossplane
detects the divergence on its next sync cycle and removes the corresponding cloud
IAM assignment. No separate cloud cleanup step is needed.

## Adding a new cloud for findings

1. Add a `Fetch<Cloud>FindingsActivity` in `activities.go`
2. Add a case to `CloudAccessReviewWorkflow` in `workflow.go`
3. Add the cloud's queue/event source infrastructure in `platform/access-review/`
