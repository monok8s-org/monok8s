package main

import (
	"context"

	"go.temporal.io/sdk/activity"
)

// SuspendMemberSpiceDBInput / ReinstateMemberSpiceDBInput — activity
// inputs for the #252 user-suspend / reinstate workflows.
type SuspendMemberSpiceDBInput struct {
	TenantID string
	UserID   string
}

type ReinstateMemberSpiceDBInput struct {
	TenantID string
	UserID   string
}

// userSuspendWriter — SpiceDB-write surface the suspend / reinstate
// activities depend on. Structurally satisfied by *auth.Client (which
// has WriteMemberSuspended + WriteMemberReinstated methods per
// packages/auth/go/spicedb.go). Tests inject a stub via
// setUserSuspendWriterForTesting.
type userSuspendWriter interface {
	WriteMemberSuspended(ctx context.Context, tenantID, userID string) (string, error)
	WriteMemberReinstated(ctx context.Context, tenantID, userID string) (string, error)
}

var userSuspendWriterSingleton userSuspendWriter

func setUserSuspendWriterForTesting(w userSuspendWriter) {
	userSuspendWriterSingleton = w
}

// getUserSuspendWriter — returns the singleton; lazy-constructs the
// production client by piggybacking on getTenantRoleWriter (same
// *auth.Client satisfies all four writer interfaces:
// tenantRoleWriter / tenantRoleChanger / groupMembershipWriter /
// userSuspendWriter).
func getUserSuspendWriter() (userSuspendWriter, error) {
	if userSuspendWriterSingleton != nil {
		return userSuspendWriterSingleton, nil
	}
	w, err := getTenantRoleWriter()
	if err != nil {
		return nil, err
	}
	if c, ok := w.(userSuspendWriter); ok {
		userSuspendWriterSingleton = c
		return c, nil
	}
	panic("getUserSuspendWriter: writer singleton does not implement userSuspendWriter; set explicit stub via setUserSuspendWriterForTesting")
}

// SuspendMemberSpiceDBActivity touches `tenant#suspended@user`.
// Idempotent: TOUCH on an existing relation is no-op.
func SuspendMemberSpiceDBActivity(ctx context.Context, input SuspendMemberSpiceDBInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("SuspendMemberSpiceDBActivity", "tenantID", input.TenantID, "userID", input.UserID)
	w, err := getUserSuspendWriter()
	if err != nil {
		return err
	}
	_, err = w.WriteMemberSuspended(ctx, input.TenantID, input.UserID)
	return err
}

// ReinstateMemberSpiceDBActivity dels `tenant#suspended@user`.
// Idempotent: DELETE on a non-existent relation is no-op.
func ReinstateMemberSpiceDBActivity(ctx context.Context, input ReinstateMemberSpiceDBInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("ReinstateMemberSpiceDBActivity", "tenantID", input.TenantID, "userID", input.UserID)
	w, err := getUserSuspendWriter()
	if err != nil {
		return err
	}
	_, err = w.WriteMemberReinstated(ctx, input.TenantID, input.UserID)
	return err
}
