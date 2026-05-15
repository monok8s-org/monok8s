package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

// TenantUserSuspendInput — args for suspending a user in a tenant
// (#252). Adds the `suspended` relation on the tenant resource. The
// user's role relation is NOT touched — reinstatement removes the
// suspended relation and the original role takes effect again
// (suspended subtracts from all permissions per
// packages/auth/schema.zed).
type TenantUserSuspendInput struct {
	TenantID    string
	UserID      string
	SuspendedBy string // audit / traceability — caller's userId
}

// TenantUserSuspendWorkflow adds the suspended relation via SpiceDB
// write activity. Lean wrapper matching TenantGroupMemberAddWorkflow
// shape (#248). Application-layer guards (admins can't suspend owners,
// last-owner protection) live in the API handler per
// packages/auth/CLAUDE.md — the workflow trusts its caller.
func TenantUserSuspendWorkflow(ctx workflow.Context, input TenantUserSuspendInput) error {
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)
	suspendInput := SuspendMemberSpiceDBInput{
		TenantID: input.TenantID,
		UserID:   input.UserID,
	}
	return workflow.ExecuteActivity(actCtx, SuspendMemberSpiceDBActivity, suspendInput).Get(actCtx, nil)
}

// TenantUserReinstateInput — args for reinstating a previously-
// suspended user.
type TenantUserReinstateInput struct {
	TenantID     string
	UserID       string
	ReinstatedBy string
}

// TenantUserReinstateWorkflow removes the suspended relation via
// SpiceDB del activity. Idempotent at the SpiceDB layer: DELETE on a
// non-existent relation succeeds.
func TenantUserReinstateWorkflow(ctx workflow.Context, input TenantUserReinstateInput) error {
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)
	reinstateInput := ReinstateMemberSpiceDBInput{
		TenantID: input.TenantID,
		UserID:   input.UserID,
	}
	return workflow.ExecuteActivity(actCtx, ReinstateMemberSpiceDBActivity, reinstateInput).Get(actCtx, nil)
}
