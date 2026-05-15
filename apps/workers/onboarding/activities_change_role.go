package main

import (
	"context"

	"go.temporal.io/sdk/activity"

	auth "github.com/monok8s/monok8s/packages/auth/go"
)

// ChangeTenantRoleSpiceDBInput — activity input for #236's
// TenantRoleChangeWorkflow. Mirrors AssignTenantRoleSpiceDBInput plus
// the role-swap pair.
type ChangeTenantRoleSpiceDBInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string
	OldRole     string
	NewRole     string
}

// tenantRoleChanger — SpiceDB write surface for the role-swap activity.
// Separate interface from tenantRoleWriter (#232) keeps the activity
// tests fully isolated; a single client (*auth.Client) satisfies both
// interfaces structurally.
type tenantRoleChanger interface {
	WriteTenantRoleChanged(ctx context.Context, tenantID string, principal auth.Principal, oldRole, newRole string) (string, error)
}

var tenantRoleChangerSingleton tenantRoleChanger

// setTenantRoleChangerForTesting — test seam mirroring
// setTenantRoleWriterForTesting from #232.
func setTenantRoleChangerForTesting(c tenantRoleChanger) {
	tenantRoleChangerSingleton = c
}

// getTenantRoleChanger — returns the singleton; lazy-constructs the
// production client on first call from SPICEDB_* env vars. Reuses
// getTenantRoleWriter's lazy-init path since the same *auth.Client
// satisfies both interfaces.
func getTenantRoleChanger() (tenantRoleChanger, error) {
	if tenantRoleChangerSingleton != nil {
		return tenantRoleChangerSingleton, nil
	}
	// Piggyback on the writer's lazy init — same client.
	w, err := getTenantRoleWriter()
	if err != nil {
		return nil, err
	}
	// *auth.Client satisfies both tenantRoleWriter + tenantRoleChanger
	// (structural typing). The cast is safe because getTenantRoleWriter
	// always returns *auth.Client in the production path.
	if c, ok := w.(tenantRoleChanger); ok {
		tenantRoleChangerSingleton = c
		return c, nil
	}
	// Defensive: a test stub that satisfies tenantRoleWriter but not
	// tenantRoleChanger triggers this path. Production *auth.Client
	// always satisfies both, so this only fires in mis-stubbed tests.
	panic("getTenantRoleChanger: writer singleton does not implement tenantRoleChanger; set explicit stub via setTenantRoleChangerForTesting")
}

// ChangeTenantRoleSpiceDBActivity atomically swaps a principal's
// tenant role via SpiceDB's batched write (DELETE old + TOUCH new).
// Idempotent on retry: re-running with the same input replays the
// same delete (no-op) + touch (no-op).
func ChangeTenantRoleSpiceDBActivity(ctx context.Context, input ChangeTenantRoleSpiceDBInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("ChangeTenantRoleSpiceDBActivity",
		"tenantID", input.TenantID,
		"subjectType", input.SubjectType,
		"subjectID", input.SubjectID,
		"oldRole", input.OldRole,
		"newRole", input.NewRole,
	)
	c, err := getTenantRoleChanger()
	if err != nil {
		return err
	}
	_, err = c.WriteTenantRoleChanged(ctx, input.TenantID,
		auth.Principal{Type: input.SubjectType, ID: input.SubjectID},
		input.OldRole, input.NewRole)
	return err
}
