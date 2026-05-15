package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

// stubUserSuspendWriter records args to its writer methods + returns
// canned values. Satisfies userSuspendWriter via structural typing.
type stubUserSuspendWriter struct {
	suspendCalls   []suspendCall
	reinstateCalls []suspendCall
	suspendErr     error
	reinstateErr   error
}

type suspendCall struct {
	tenantID string
	userID   string
}

func (s *stubUserSuspendWriter) WriteMemberSuspended(_ context.Context, tenantID, userID string) (string, error) {
	s.suspendCalls = append(s.suspendCalls, suspendCall{tenantID, userID})
	return "zedtoken-test", s.suspendErr
}

func (s *stubUserSuspendWriter) WriteMemberReinstated(_ context.Context, tenantID, userID string) (string, error) {
	s.reinstateCalls = append(s.reinstateCalls, suspendCall{tenantID, userID})
	return "zedtoken-test", s.reinstateErr
}

func TestSuspendMemberSpiceDBActivity_CallsWriterWithIds(t *testing.T) {
	stub := &stubUserSuspendWriter{}
	setUserSuspendWriterForTesting(stub)
	t.Cleanup(func() { setUserSuspendWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(SuspendMemberSpiceDBActivity)

	_, err := env.ExecuteActivity(SuspendMemberSpiceDBActivity,
		SuspendMemberSpiceDBInput{TenantID: "tenant-1", UserID: "user-99"})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if len(stub.suspendCalls) != 1 {
		t.Fatalf("suspend calls: got %d, want 1", len(stub.suspendCalls))
	}
	if stub.suspendCalls[0] != (suspendCall{"tenant-1", "user-99"}) {
		t.Fatalf("suspend call: got %+v, want {tenant-1, user-99}", stub.suspendCalls[0])
	}
}

func TestSuspendMemberSpiceDBActivity_PropagatesWriterError(t *testing.T) {
	sentinel := errors.New("spicedb: NamespaceNotFound")
	stub := &stubUserSuspendWriter{suspendErr: sentinel}
	setUserSuspendWriterForTesting(stub)
	t.Cleanup(func() { setUserSuspendWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(SuspendMemberSpiceDBActivity)

	_, err := env.ExecuteActivity(SuspendMemberSpiceDBActivity,
		SuspendMemberSpiceDBInput{TenantID: "t1", UserID: "u1"})
	if err == nil {
		t.Fatalf("expected activity to propagate writer error")
	}
}

func TestReinstateMemberSpiceDBActivity_DispatchesToReinstateWriter(t *testing.T) {
	stub := &stubUserSuspendWriter{}
	setUserSuspendWriterForTesting(stub)
	t.Cleanup(func() { setUserSuspendWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(ReinstateMemberSpiceDBActivity)

	_, err := env.ExecuteActivity(ReinstateMemberSpiceDBActivity,
		ReinstateMemberSpiceDBInput{TenantID: "tenant-1", UserID: "user-99"})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if len(stub.reinstateCalls) != 1 {
		t.Fatalf("reinstate calls: got %d, want 1", len(stub.reinstateCalls))
	}
	if len(stub.suspendCalls) != 0 {
		t.Fatalf("suspend calls should be 0 for reinstate activity, got %d", len(stub.suspendCalls))
	}
}
