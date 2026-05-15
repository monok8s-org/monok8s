package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

// Local registerAs — each Bazel go_test is its own compile unit; same
// rationale as workflow_group_member_test.go.
type registerOptsUS = struct {
	Name                          string
	DisableAlreadyRegisteredCheck bool
	SkipInvalidStructFunctions    bool
}

func registerAs(name string) registerOptsUS {
	return registerOptsUS{Name: name}
}

// TestTenantUserSuspendWorkflow_InvokesActivity asserts the workflow
// dispatches SuspendMemberSpiceDBActivity exactly once with input
// fields lifted from TenantUserSuspendInput.
func TestTenantUserSuspendWorkflow_InvokesActivity(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got SuspendMemberSpiceDBInput
	var calls int
	env.RegisterActivityWithOptions(
		func(_ context.Context, input SuspendMemberSpiceDBInput) error {
			calls++
			got = input
			return nil
		},
		registerAs("SuspendMemberSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantUserSuspendWorkflow, TenantUserSuspendInput{
		TenantID:    "tenant-1",
		UserID:      "user-99",
		SuspendedBy: "user-bb",
	})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow error: %v", err)
	}
	if calls != 1 {
		t.Fatalf("activity calls: got %d, want 1", calls)
	}
	want := SuspendMemberSpiceDBInput{TenantID: "tenant-1", UserID: "user-99"}
	if got != want {
		t.Fatalf("activity input: got %+v, want %+v", got, want)
	}
}

// TestTenantUserSuspendWorkflow_PropagatesActivityError — error from
// the activity surfaces to the workflow caller.
func TestTenantUserSuspendWorkflow_PropagatesActivityError(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	sentinel := errors.New("spicedb: connection refused")
	env.RegisterActivityWithOptions(
		func(_ context.Context, _ SuspendMemberSpiceDBInput) error {
			return sentinel
		},
		registerAs("SuspendMemberSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantUserSuspendWorkflow, TenantUserSuspendInput{
		TenantID: "tenant-1", UserID: "u1",
	})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	if err := env.GetWorkflowError(); err == nil {
		t.Fatalf("workflow should have propagated activity error")
	}
}

// TestTenantUserReinstateWorkflow_InvokesActivity — mirror of suspend
// for the reverse direction.
func TestTenantUserReinstateWorkflow_InvokesActivity(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got ReinstateMemberSpiceDBInput
	var calls int
	env.RegisterActivityWithOptions(
		func(_ context.Context, input ReinstateMemberSpiceDBInput) error {
			calls++
			got = input
			return nil
		},
		registerAs("ReinstateMemberSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantUserReinstateWorkflow, TenantUserReinstateInput{
		TenantID: "tenant-1", UserID: "user-99",
		ReinstatedBy: "user-bb",
	})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow error: %v", err)
	}
	if calls != 1 {
		t.Fatalf("activity calls: got %d, want 1", calls)
	}
	want := ReinstateMemberSpiceDBInput{TenantID: "tenant-1", UserID: "user-99"}
	if got != want {
		t.Fatalf("activity input: got %+v, want %+v", got, want)
	}
}
