package securityfindings

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// SecurityFindingWorkflow processes a single cloud security finding.
//
// Outcome:
//   "forwarded"  — finding routed to Alertmanager with tenant context injected
//   "resolved"   — finding was already resolved/suppressed in cloud; no action
//   "orphaned"   — affected resource has no matching tenant; logged as incident
//   "error"      — processing failed after retries
//
// Task queue: "security-findings"
func SecurityFindingWorkflow(ctx workflow.Context, finding NormalisedFinding) (string, error) {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    2 * time.Minute,
			MaximumAttempts:    5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Resolve the tenant ID from the resource tags.
	var tenantID string
	if err := workflow.ExecuteActivity(ctx, ResolveTenantFromResourceActivity, finding).Get(ctx, &tenantID); err != nil {
		// Resolution failure means the resource has no tenant tag — it's either
		// a platform resource or an orphaned finding. Log it and move on.
		workflow.GetLogger(ctx).Warn("could not resolve tenant for security finding",
			"finding_id", finding.FindingID, "cloud", finding.Cloud)
		if err2 := workflow.ExecuteActivity(ctx, WriteOrphanedFindingActivity, finding).Get(ctx, nil); err2 != nil {
			workflow.GetLogger(ctx).Error("failed to write orphaned finding", "err", err2)
		}
		return "orphaned", nil
	}

	// Enrich the finding with tenant context before forwarding.
	finding.TenantID = tenantID

	// Forward to Alertmanager via the same ingestAlerts path used by Model B.
	// The activity injects tenant_id and source labels so the alert routes
	// to the correct tenant's notification channel.
	if err := workflow.ExecuteActivity(ctx, ForwardFindingToAlertmanagerActivity, finding).Get(ctx, nil); err != nil {
		return "error", err
	}

	// Write to the security_finding_incidents table for the ops dashboard.
	if err := workflow.ExecuteActivity(ctx, WriteSecurityFindingAuditActivity, finding).Get(ctx, nil); err != nil {
		workflow.GetLogger(ctx).Error("failed to write security finding audit", "err", err)
		// Non-fatal — finding was already forwarded; audit failure shouldn't cause a retry.
	}

	return "forwarded", nil
}

// NormalisedFinding is the cloud-agnostic representation of a security finding.
// Consumers (consumer_gcp.go, consumer_aws.go, consumer_azure.go) translate
// cloud-specific payloads into this struct before starting the workflow.
type NormalisedFinding struct {
	FindingID    string    // cloud-native finding/alert ID (for deduplication)
	Cloud        string    // "aws" | "azure" | "gcp"
	TenantID     string    // set by ResolveTenantFromResourceActivity
	ResourceType string    // monok8s.io/resource-type from cloud tags, or raw cloud resource type
	ResourceID   string    // monok8s.io/resource-id from cloud tags
	ResourceARN  string    // cloud-native resource identifier (for linking back to cloud console)
	Severity     string    // "critical" | "high" | "medium" | "low"
	Title        string    // human-readable finding title
	Description  string
	FindingType  string    // "vulnerability" | "misconfiguration" | "threat" | "access"
	Status       string    // "active" | "resolved" | "suppressed"
	RawPayload   string    // original cloud event JSON
	ReceivedAt   time.Time
}
