package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

// stubGroupMembershipWriter records args to its writer methods +
// returns canned values. Satisfies groupMembershipWriter via
// structural typing.
type stubGroupMembershipWriter struct {
	addCalls    []memberCall
	removeCalls []memberCall
	addErr      error
	removeErr   error
}

type memberCall struct {
	groupID string
	userID  string
}

func (s *stubGroupMembershipWriter) WriteGroupMemberAdded(_ context.Context, groupID, userID string) (string, error) {
	s.addCalls = append(s.addCalls, memberCall{groupID, userID})
	return "zedtoken-test", s.addErr
}

func (s *stubGroupMembershipWriter) WriteGroupMemberRemoved(_ context.Context, groupID, userID string) (string, error) {
	s.removeCalls = append(s.removeCalls, memberCall{groupID, userID})
	return "zedtoken-test", s.removeErr
}

func TestAddGroupMemberSpiceDBActivity_CallsWriterWithIds(t *testing.T) {
	stub := &stubGroupMembershipWriter{}
	setGroupMembershipWriterForTesting(stub)
	t.Cleanup(func() { setGroupMembershipWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(AddGroupMemberSpiceDBActivity)

	_, err := env.ExecuteActivity(AddGroupMemberSpiceDBActivity,
		AddGroupMemberSpiceDBInput{GroupID: "group-1", UserID: "user-99"})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if len(stub.addCalls) != 1 {
		t.Fatalf("add calls: got %d, want 1", len(stub.addCalls))
	}
	if stub.addCalls[0] != (memberCall{"group-1", "user-99"}) {
		t.Fatalf("add call: got %+v, want {group-1, user-99}", stub.addCalls[0])
	}
}

func TestAddGroupMemberSpiceDBActivity_PropagatesWriterError(t *testing.T) {
	sentinel := errors.New("spicedb: NamespaceNotFound")
	stub := &stubGroupMembershipWriter{addErr: sentinel}
	setGroupMembershipWriterForTesting(stub)
	t.Cleanup(func() { setGroupMembershipWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(AddGroupMemberSpiceDBActivity)

	_, err := env.ExecuteActivity(AddGroupMemberSpiceDBActivity,
		AddGroupMemberSpiceDBInput{GroupID: "g1", UserID: "u1"})
	if err == nil {
		t.Fatalf("expected activity to propagate writer error")
	}
}

func TestRemoveGroupMemberSpiceDBActivity_DispatchesToRemoveWriter(t *testing.T) {
	stub := &stubGroupMembershipWriter{}
	setGroupMembershipWriterForTesting(stub)
	t.Cleanup(func() { setGroupMembershipWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(RemoveGroupMemberSpiceDBActivity)

	_, err := env.ExecuteActivity(RemoveGroupMemberSpiceDBActivity,
		RemoveGroupMemberSpiceDBInput{GroupID: "group-1", UserID: "user-99"})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if len(stub.removeCalls) != 1 {
		t.Fatalf("remove calls: got %d, want 1", len(stub.removeCalls))
	}
	if len(stub.addCalls) != 0 {
		t.Fatalf("add calls should be 0 for remove activity, got %d", len(stub.addCalls))
	}
}
