package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

// TenantGroupMemberAddInput — args for adding a user to a group
// (#248). User-only for v1 — nested-group membership is a separate
// workflow when needed.
type TenantGroupMemberAddInput struct {
	TenantID string // for workflowId composition + audit trace only;
	// the SpiceDB write itself doesn't touch the tenant resource
	GroupID string
	UserID  string
	AddedBy string // audit / traceability — caller's userId
}

// TenantGroupMemberAddWorkflow adds a user as a group member via
// SpiceDB write activity. Lean wrapper following the same shape as
// TenantRoleAssignWorkflow (#232).
func TenantGroupMemberAddWorkflow(ctx workflow.Context, input TenantGroupMemberAddInput) error {
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)
	addInput := AddGroupMemberSpiceDBInput{
		GroupID: input.GroupID,
		UserID:  input.UserID,
	}
	return workflow.ExecuteActivity(actCtx, AddGroupMemberSpiceDBActivity, addInput).Get(actCtx, nil)
}

// TenantGroupMemberRemoveInput — args for removing a user from a
// group.
type TenantGroupMemberRemoveInput struct {
	TenantID  string
	GroupID   string
	UserID    string
	RemovedBy string
}

// TenantGroupMemberRemoveWorkflow removes a user from a group via
// SpiceDB del activity. Idempotent at the SpiceDB layer.
func TenantGroupMemberRemoveWorkflow(ctx workflow.Context, input TenantGroupMemberRemoveInput) error {
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)
	removeInput := RemoveGroupMemberSpiceDBInput{
		GroupID: input.GroupID,
		UserID:  input.UserID,
	}
	return workflow.ExecuteActivity(actCtx, RemoveGroupMemberSpiceDBActivity, removeInput).Get(actCtx, nil)
}
