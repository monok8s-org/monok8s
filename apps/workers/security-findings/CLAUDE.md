# apps/workers/security-findings/

Temporal worker that consumes cloud security findings (AWS Security Hub,
Azure Defender for Cloud, GCP Security Command Center) and routes them to
Alertmanager with tenant context injected. Runs on task queue `"security-findings"`.

## Architecture

```
Cloud security service
  → Cloud message queue (SQS / Service Bus / Pub/Sub)
    → consumer_{aws,azure,gcp}.go  (polls queue, starts Temporal workflow)
      → SecurityFindingWorkflow (workflow.go)
        → ResolveTenantFromResourceActivity   — extract tenant_id from resource tags
        → ForwardFindingToAlertmanagerActivity — POST to Alertmanager with labels
        → WriteSecurityFindingAuditActivity   — persist to security_finding_incidents
```

## Infrastructure

Queue/topic resources are in `platform/security-findings/{aws,azure,gcp}/resources.yaml`.
KEDA ScaledObjects are in `platform/keda/security-findings.yaml`.

## Tenant resolution

Findings include the affected cloud resource's metadata. The consumer extracts
`monok8s.io/tenant-id` from resource tags/labels (set by Crossplane on all
provisioned resources) and populates `NormalisedFinding.TenantID`.

If the tag is absent (e.g. a platform resource, or a manually-created resource),
`ResolveTenantFromResourceActivity` falls back to a `cloud_resources` lookup
by ARN. If still unresolved, the finding is logged as `orphaned` in the ops
dashboard but does not alert.

## Alertmanager routing

Forwarded findings carry these labels:
- `alertname=SecurityFinding`
- `severity=<critical|high|medium|low>`
- `tenant_id=<uuid>`
- `cloud=<aws|azure|gcp>`
- `source=security_findings`
- `finding_type=<threat|vulnerability|misconfiguration|access>`

Alertmanager routes on `tenant_id` to deliver to the correct tenant's
notification channel. The routing rules already exist (same rules used for
Model B alerts).

## Ops dashboard

All findings (including orphaned) are in the `security_finding_incidents`
table. Filter by `status = 'active'` and `tenant_id IS NULL` to see unresolved
orphaned findings needing manual investigation.

## Cloud console deep links

`cloudConsoleLink()` in `activities.go` generates a direct URL to the finding
in each cloud's native console. These appear as `cloud_link` annotation in
Alertmanager alerts and in the ops dashboard.

## Idempotency

Each finding has a cloud-native ID used as the Temporal workflow ID prefix and
as the `security_finding_incidents` primary key. Duplicate deliveries from the
queue produce no duplicate workflows (Temporal dedup) and no duplicate rows
(PostgreSQL `ON CONFLICT DO NOTHING`).
