package iamwriteback

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/workflow"
)

// IAMWritebackWorkflow processes a single cloud IAM role assignment change and
// reconciles it with SpiceDB.
//
// SpiceDB is the canonical authority. The possible outcomes are:
//
//   "ignored"  — event originated from Crossplane; skip.
//   "granted"  — valid assignment, subject exists in monok8s; SpiceDB updated.
//   "revoked"  — valid revocation; SpiceDB updated.
//   "reverted" — subject not found in monok8s; cloud assignment deleted via Crossplane.
//   "error"    — unretryable failure; sent to dead-letter topic.
func IAMWritebackWorkflow(ctx workflow.Context, input CloudRoleEvent) (string, error) {
	opts := workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		// Don't retry revert — if SpiceDB check fails, leave the cloud state alone
		// rather than retrying and potentially creating a write-back storm.
	}
	ctx = workflow.WithActivityOptions(ctx, opts)

	// Events from Crossplane are pre-filtered at the cloud layer but we apply
	// a belt-and-suspenders check here.
	if input.OriginatedByMonok8s {
		return "ignored", nil
	}

	// Validate the event carries a translatable role and tenant reference.
	if input.Role == "" || input.TenantID == "" {
		return "error", fmt.Errorf("untranslatable event: role=%q tenantID=%q cloud=%s",
			input.Role, input.TenantID, input.Cloud)
	}

	// Verify the subject (user or SA) exists in monok8s and belongs to the tenant.
	var subjectExists bool
	err := workflow.ExecuteActivity(ctx, ValidateSubjectActivity, ValidateSubjectInput{
		SubjectID:   input.SubjectID,
		SubjectType: input.SubjectType,
		TenantID:    input.TenantID,
	}).Get(ctx, &subjectExists)
	if err != nil {
		return "error", err
	}

	if !subjectExists {
		// The cloud assignment references a principal that isn't a monok8s tenant member.
		// Revert the cloud change so it doesn't accumulate dangling assignments.
		revertErr := workflow.ExecuteActivity(ctx, RevertCloudAssignmentActivity, input).Get(ctx, nil)
		if revertErr != nil {
			// Log but don't fail — the SpiceDB state is already correct (unchanged).
			// The cloud assignment will be reconciled on next Crossplane sync.
			workflow.GetLogger(ctx).Warn("failed to revert cloud assignment",
				"cloud", input.Cloud,
				"tenantID", input.TenantID,
				"subjectID", input.SubjectID,
				"error", revertErr,
			)
		}
		return "reverted", nil
	}

	// Write to SpiceDB.
	writeInput := WriteSpiceDBInput{
		EventType:   input.EventType,
		TenantID:    input.TenantID,
		SubjectID:   input.SubjectID,
		SubjectType: input.SubjectType,
		Role:        input.Role,
	}
	var zedToken string
	if err := workflow.ExecuteActivity(ctx, WriteSpiceDBActivity, writeInput).Get(ctx, &zedToken); err != nil {
		return "error", err
	}

	// Append audit record to tenant_membership_events.
	auditInput := AuditInput{
		TenantID:    input.TenantID,
		SubjectID:   input.SubjectID,
		EventType:   "membership." + input.EventType + ".via_cloud_iam",
		Role:        input.Role,
		Cloud:       input.Cloud,
		MessageID:   input.MessageID,
	}
	if err := workflow.ExecuteActivity(ctx, WriteAuditEventActivity, auditInput).Get(ctx, nil); err != nil {
		// Non-fatal: SpiceDB is already updated. Log and continue.
		workflow.GetLogger(ctx).Warn("audit write failed", "error", err)
	}

	return input.EventType, nil
}

// Input/output types for activities defined in activities.go

type ValidateSubjectInput struct {
	SubjectID   string
	SubjectType string
	TenantID    string
}

type WriteSpiceDBInput struct {
	EventType   string // "assigned" | "revoked"
	TenantID    string
	SubjectID   string
	SubjectType string
	Role        string
}

type AuditInput struct {
	TenantID  string
	SubjectID string
	EventType string
	Role      string
	Cloud     string
	MessageID string
}
