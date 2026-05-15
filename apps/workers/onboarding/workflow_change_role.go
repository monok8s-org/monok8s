package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

// TenantRoleChangeInput carries the args for an atomic role swap on a
// principal (#236). Same shape as TenantRoleAssignInput plus OldRole;
// NewRole replaces Role since "the role that's changing" is ambiguous
// in the assign/unassign context.
//
// The Go workflow trusts its caller (TS-side zod schema enforces
// OldRole != NewRole + the owner-cannot-be-service_account constraint
// applied to NewRole).
type TenantRoleChangeInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string // "user" | "service_account"
	OldRole     string
	NewRole     string
	ChangedBy   string // audit / traceability — caller's userId
}

// TenantRoleChangeWorkflow swaps a principal's tenant role atomically
// via a single SpiceDB write (DELETE old + TOUCH new). Same lean
// wrapper shape as TenantRoleAssignWorkflow (#232); the workflow
// adds durability + retry around the activity.
func TenantRoleChangeWorkflow(ctx workflow.Context, input TenantRoleChangeInput) error {
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)
	changeInput := ChangeTenantRoleSpiceDBInput{
		TenantID:    input.TenantID,
		SubjectID:   input.SubjectID,
		SubjectType: input.SubjectType,
		OldRole:     input.OldRole,
		NewRole:     input.NewRole,
	}
	return workflow.ExecuteActivity(actCtx, ChangeTenantRoleSpiceDBActivity, changeInput).Get(actCtx, nil)
}
