package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

type TemporaryGrantInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string // "user" | "service_account"
	Role        string
	GrantID     string // temporary_grants.id — for status update on completion
	ExpiryISO   string // ISO 8601 — must match the expiry baked into the SpiceDB caveat
}

// TemporaryGrantWorkflow manages the lifecycle of a time-bounded role elevation.
//
// The SpiceDB expiry caveat makes the relation inert after ExpiryISO without any
// cleanup. This workflow provides belt-and-suspenders: it removes the relation
// exactly on expiry so SpiceDB doesn't accumulate stale caveat'd relationships,
// and it can be cancelled early if the grant is manually revoked.
//
// Signal "revoke" cancels the timer and immediately removes the relation.
func TemporaryGrantWorkflow(ctx workflow.Context, input TemporaryGrantInput) error {
	expiry, err := time.Parse(time.RFC3339, input.ExpiryISO)
	if err != nil {
		return err
	}

	revokeSignal := workflow.GetSignalChannel(ctx, "revoke")

	// Wait until expiry or an early revocation signal — whichever comes first.
	// time.Time has no Until method (that's a stdlib top-level function in
	// terms of time.Now); compute the duration explicitly via Sub so the
	// workflow stays deterministic (workflow.Now is the Temporal-deterministic
	// clock; time.Now would break replay).
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	timer := workflow.NewTimer(timerCtx, expiry.Sub(workflow.Now(ctx)))

	var timerFired, signalFired bool

	workflow.Go(ctx, func(gCtx workflow.Context) {
		_ = timer.Get(gCtx, nil)
		timerFired = true
	})

	workflow.Go(ctx, func(gCtx workflow.Context) {
		revokeSignal.Receive(gCtx, nil)
		signalFired = true
		cancelTimer()
	})

	// Block until either branch sets its flag.
	_ = workflow.Await(ctx, func() bool { return timerFired || signalFired })

	// Remove the SpiceDB relation regardless of how we got here.
	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 1 * time.Minute}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)

	removeInput := RemoveGrantSpiceDBInput{
		TenantID:    input.TenantID,
		SubjectID:   input.SubjectID,
		SubjectType: input.SubjectType,
		Role:        input.Role,
	}
	if err := workflow.ExecuteActivity(actCtx, RemoveGrantSpiceDBActivity, removeInput).Get(actCtx, nil); err != nil {
		return err
	}

	// Mark the DB record as expired or revoked.
	finalStatus := "expired"
	if signalFired {
		finalStatus = "revoked"
	}
	updateInput := UpdateGrantStatusInput{
		GrantID: input.GrantID,
		Status:  finalStatus,
	}
	return workflow.ExecuteActivity(actCtx, UpdateGrantStatusActivity, updateInput).Get(actCtx, nil)
}

type RemoveGrantSpiceDBInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string
	Role        string
}

type UpdateGrantStatusInput struct {
	GrantID string
	Status  string // "expired" | "revoked"
}
