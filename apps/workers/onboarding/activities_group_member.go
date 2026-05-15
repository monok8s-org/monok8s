package main

import (
	"context"

	"go.temporal.io/sdk/activity"
)

// AddGroupMemberSpiceDBInput / RemoveGroupMemberSpiceDBInput —
// activity inputs for #248 group-membership workflows.
type AddGroupMemberSpiceDBInput struct {
	GroupID string
	UserID  string
}

type RemoveGroupMemberSpiceDBInput struct {
	GroupID string
	UserID  string
}

// groupMembershipWriter — SpiceDB-write surface the membership
// activities depend on. Structurally satisfied by *auth.Client
// (which has WriteGroupMemberAdded + WriteGroupMemberRemoved
// methods). Tests inject a stub via setGroupMembershipWriterForTesting.
type groupMembershipWriter interface {
	WriteGroupMemberAdded(ctx context.Context, groupID, userID string) (string, error)
	WriteGroupMemberRemoved(ctx context.Context, groupID, userID string) (string, error)
}

var groupMembershipWriterSingleton groupMembershipWriter

func setGroupMembershipWriterForTesting(w groupMembershipWriter) {
	groupMembershipWriterSingleton = w
}

// getGroupMembershipWriter — returns the singleton; lazy-constructs
// the production client by piggybacking on getTenantRoleWriter
// (same *auth.Client satisfies all three writer interfaces).
func getGroupMembershipWriter() (groupMembershipWriter, error) {
	if groupMembershipWriterSingleton != nil {
		return groupMembershipWriterSingleton, nil
	}
	w, err := getTenantRoleWriter()
	if err != nil {
		return nil, err
	}
	if c, ok := w.(groupMembershipWriter); ok {
		groupMembershipWriterSingleton = c
		return c, nil
	}
	panic("getGroupMembershipWriter: writer singleton does not implement groupMembershipWriter; set explicit stub via setGroupMembershipWriterForTesting")
}

// AddGroupMemberSpiceDBActivity touches `group#member@user`.
// Idempotent: TOUCH on existing relation is no-op.
func AddGroupMemberSpiceDBActivity(ctx context.Context, input AddGroupMemberSpiceDBInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("AddGroupMemberSpiceDBActivity", "groupID", input.GroupID, "userID", input.UserID)
	w, err := getGroupMembershipWriter()
	if err != nil {
		return err
	}
	_, err = w.WriteGroupMemberAdded(ctx, input.GroupID, input.UserID)
	return err
}

// RemoveGroupMemberSpiceDBActivity dels `group#member@user`.
// Idempotent: DELETE on non-existent relation is no-op.
func RemoveGroupMemberSpiceDBActivity(ctx context.Context, input RemoveGroupMemberSpiceDBInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("RemoveGroupMemberSpiceDBActivity", "groupID", input.GroupID, "userID", input.UserID)
	w, err := getGroupMembershipWriter()
	if err != nil {
		return err
	}
	_, err = w.WriteGroupMemberRemoved(ctx, input.GroupID, input.UserID)
	return err
}
