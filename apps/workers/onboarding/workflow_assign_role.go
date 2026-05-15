package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

// TenantRoleAssignInput carries the args for granting a tenant role to
// a principal (#232). Mirrors the TS-side AssignRoleSchema; the
// Go workflow trusts its caller (the API procedure runs the zod
// schema's `.refine()` checks before starting the workflow, so the
// schema-constraint "owner can't go to service_account" never reaches
// the workflow).
type TenantRoleAssignInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string // "user" | "service_account"
	Role        string // TenantRole (not "owner" for service_account subjects)
	AssignedBy  string // audit / traceability — caller's userId
}

// TenantRoleAssignWorkflow grants a tenant role via SpiceDB write
// activity. Intentionally lean — just a wrapper around the activity.
// Future enrichments (audit log emit, status NATS publish) can layer
// on without changing the input contract.
//
// The workflow exists at all because of the packages/auth/CLAUDE.md
// rule "relation writes belong in Temporal activities, not API
// handlers" — durability + retry come for free, and the API handler
// stays sync-and-thin.
func TenantRoleAssignWorkflow(ctx workflow.Context, input TenantRoleAssignInput) error {
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)
	assignInput := AssignTenantRoleSpiceDBInput{
		TenantID:    input.TenantID,
		SubjectID:   input.SubjectID,
		SubjectType: input.SubjectType,
		Role:        input.Role,
	}
	return workflow.ExecuteActivity(actCtx, AssignTenantRoleSpiceDBActivity, assignInput).Get(actCtx, nil)
}

// TenantRoleUnassignInput — mirror of TenantRoleAssignInput for the
// reverse direction. Same fields; the SubjectType + Role values feed
// the SpiceDB DELETE.
type TenantRoleUnassignInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string
	Role        string
	UnassignedBy string
}

// TenantRoleUnassignWorkflow removes a tenant role via SpiceDB delete
// activity. Same shape as TenantRoleAssignWorkflow — the lean wrapper
// keeps the contract simple for the API consumer.
//
// Idempotent at the SpiceDB layer: removing a relation that doesn't
// exist is a no-op (DELETE_OPERATION returns success).
func TenantRoleUnassignWorkflow(ctx workflow.Context, input TenantRoleUnassignInput) error {
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)
	unassignInput := UnassignTenantRoleSpiceDBInput{
		TenantID:    input.TenantID,
		SubjectID:   input.SubjectID,
		SubjectType: input.SubjectType,
		Role:        input.Role,
	}
	return workflow.ExecuteActivity(actCtx, UnassignTenantRoleSpiceDBActivity, unassignInput).Get(actCtx, nil)
}
