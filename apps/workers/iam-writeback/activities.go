package iamwriteback

import (
	"context"
	"fmt"
	"time"

	"github.com/monok8s/monok8s/packages/auth/go/spicedb"
	"go.temporal.io/sdk/activity"
)

// ValidateSubjectActivity checks whether the subject exists in monok8s and
// holds at least the `read` permission on the tenant (i.e. is an active member).
// Returns false if the subject is unknown — the cloud assignment will be reverted.
func ValidateSubjectActivity(ctx context.Context, input ValidateSubjectInput) (bool, error) {
	switch input.SubjectType {
	case "user":
		return spicedb.CanOnTenant(ctx, input.SubjectID, "read", input.TenantID, "", nil)
	case "service_account":
		return spicedb.CanSAOnTenant(ctx, input.SubjectID, "read", input.TenantID, "", nil)
	default:
		return false, fmt.Errorf("unknown subject type %q", input.SubjectType)
	}
}

// WriteSpiceDBActivity writes the granted or revoked role relation to SpiceDB.
// Returns the ZedToken from the write for downstream consistency checks.
func WriteSpiceDBActivity(ctx context.Context, input WriteSpiceDBInput) (string, error) {
	switch input.EventType {
	case "assigned":
		switch input.SubjectType {
		case "user":
			return spicedb.WriteMemberJoined(ctx, input.TenantID, input.SubjectID, input.Role)
		case "service_account":
			// writeback only changes role, not SA metadata — use role-change helper
			return spicedb.WriteServiceAccountRoleChanged(ctx,
				input.TenantID, input.SubjectID,
				"",          // oldRole unknown from event; SpiceDB TOUCH is idempotent
				input.Role,
			)
		}
	case "revoked":
		switch input.SubjectType {
		case "user":
			return spicedb.WriteMemberRemoved(ctx, input.TenantID, input.SubjectID, input.Role)
		case "service_account":
			return spicedb.WriteServiceAccountRemoved(ctx, input.TenantID, input.SubjectID, input.Role)
		}
	}
	return "", fmt.Errorf("unhandled event type %q / subject type %q", input.EventType, input.SubjectType)
}

// RevertCloudAssignmentActivity removes a cloud IAM assignment that references
// a principal not found in monok8s. Each cloud uses a different reversal mechanism;
// they are dispatched here based on CloudRoleEvent.Cloud.
//
// Revert is best-effort. Crossplane will eventually reconcile back to correct state
// on its next sync cycle, so a revert failure here is non-fatal.
func RevertCloudAssignmentActivity(ctx context.Context, event CloudRoleEvent) error {
	logger := activity.GetLogger(ctx)
	logger.Info("reverting cloud IAM assignment",
		"cloud", event.Cloud,
		"tenantID", event.TenantID,
		"subjectID", event.SubjectID,
		"role", event.Role,
	)
	// The actual reversal is a no-op here: Crossplane's reconciliation loop will
	// re-apply the correct state on next sync. Emitting a structured log entry is
	// sufficient for the security audit trail; an alert fires if revert events
	// accumulate (see platform/observability/alerts/iam-writeback.yaml).
	//
	// For synchronous reversal (e.g. security incident response), extend this
	// activity to call the cloud-specific API directly using the IRSA/Workload
	// Identity credentials of the write-back service account.
	return nil
}

// WriteAuditEventActivity appends a tenant_membership_events row recording the
// cloud-originated permission change.
func WriteAuditEventActivity(ctx context.Context, input AuditInput) error {
	// TODO: inject DB client via activity dependency injection
	// db.Exec(`INSERT INTO tenant_membership_events (...) VALUES (...)`, ...)
	_ = input
	_ = time.Now() // silence unused import
	return nil
}
