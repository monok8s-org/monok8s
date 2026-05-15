package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

type UserInput struct {
	TenantID string
	UserID   string
	Email    string // plaintext — encrypted by ProvisionVaultKeyActivity before storage
	Role     string
}

// RegisterUserWorkflow runs when a new user accepts an invitation or self-registers.
//
// Steps:
//  1. Provision Vault Transit key for this user (crypto-shredding on erasure)
//  2. Encrypt PII and write to user_pii
//  3. Write initial user_events (user.registered)
//  4. Write SpiceDB relations (user self + platform back-reference)
//  5. Write tenant membership SpiceDB relation
//  6. Append tenant_membership_events (membership.invite_accepted or membership.registered)
func RegisterUserWorkflow(ctx workflow.Context, input UserInput) error {
	opts := workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, opts)

	// 1. Create Vault Transit key: transit/keys/user-<user_id>
	// Idempotent: Vault ignores duplicate create requests for the same key name.
	if err := workflow.ExecuteActivity(ctx, ProvisionVaultKeyActivity, input.UserID).Get(ctx, nil); err != nil {
		return err
	}

	// 2. Encrypt PII via Vault Transit and write user_pii row
	if err := workflow.ExecuteActivity(ctx, WritePIIActivity, input).Get(ctx, nil); err != nil {
		return err
	}

	// 3. Append user.registered event + rebuild snapshot
	if err := workflow.ExecuteActivity(ctx, WriteUserEventActivity, input).Get(ctx, nil); err != nil {
		return err
	}

	// 4. Write SpiceDB user self-reference and platform back-reference
	var zedToken string
	if err := workflow.ExecuteActivity(ctx, WriteUserSpiceDBActivity, input.UserID).Get(ctx, &zedToken); err != nil {
		return err
	}

	// 5. Write SpiceDB tenant membership relation (uses zedToken from step 4)
	memberInput := MemberSpiceDBInput{
		TenantID: input.TenantID,
		UserID:   input.UserID,
		Role:     input.Role,
		ZedToken: zedToken,
	}
	var memberZedToken string
	if err := workflow.ExecuteActivity(ctx, WriteMemberSpiceDBActivity, memberInput).Get(ctx, &memberZedToken); err != nil {
		return err
	}

	// 6. Append membership event (audit log)
	memberEventInput := MemberEventInput{
		TenantID:    input.TenantID,
		UserID:      input.UserID,
		EventType:   "membership.invite_accepted",
		Role:        input.Role,
		CorrelationID: workflow.GetInfo(ctx).WorkflowExecution.ID,
	}
	if err := workflow.ExecuteActivity(ctx, WriteMemberEventActivity, memberEventInput).Get(ctx, nil); err != nil {
		return err
	}

	return nil
}

// ErasureWorkflow implements GDPR right-to-erasure via crypto-shredding.
//
// Deleting the Vault Transit key makes all user_pii ciphertext permanently
// unreadable without touching the event log (preserving audit history).
// User snapshots and events retain non-PII fields (status, timestamps).
func ErasureWorkflow(ctx workflow.Context, userID string) error {
	opts := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, opts)

	// 1. Append user.deleted event (preserves audit trail)
	if err := workflow.ExecuteActivity(ctx, WriteUserDeletedEventActivity, userID).Get(ctx, nil); err != nil {
		return err
	}

	// 2. Delete Vault Transit key — ciphertext in user_pii is now unreadable
	if err := workflow.ExecuteActivity(ctx, DeleteVaultKeyActivity, userID).Get(ctx, nil); err != nil {
		return err
	}

	// 3. Nullify user_pii row (ciphertext is garbage now, remove to free space)
	if err := workflow.ExecuteActivity(ctx, DeletePIIRowActivity, userID).Get(ctx, nil); err != nil {
		return err
	}

	// 4. Revoke Zitadel identity
	if err := workflow.ExecuteActivity(ctx, RevokeZitadelUserActivity, userID).Get(ctx, nil); err != nil {
		return err
	}

	// 5. Remove SpiceDB relations (user self + all tenant memberships)
	if err := workflow.ExecuteActivity(ctx, RemoveUserSpiceDBActivity, userID).Get(ctx, nil); err != nil {
		return err
	}

	return nil
}

// Input types for activities defined in activities_user.go

type MemberSpiceDBInput struct {
	TenantID string
	UserID   string
	Role     string
	ZedToken string
}

type MemberEventInput struct {
	TenantID      string
	UserID        string
	EventType     string
	Role          string
	CorrelationID string
}
