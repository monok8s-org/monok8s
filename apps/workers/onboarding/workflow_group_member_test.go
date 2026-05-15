package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

// Local registerAs — each Bazel go_test is its own compile unit; same
// rationale as workflow_assign_role_test.go.
type registerOptsGM = struct {
	Name                          string
	DisableAlreadyRegisteredCheck bool
	SkipInvalidStructFunctions    bool
}

func registerAs(name string) registerOptsGM {
	return registerOptsGM{Name: name}
}

// TestTenantGroupMemberAddWorkflow_InvokesActivity asserts the
// workflow dispatches AddGroupMemberSpiceDBActivity exactly once
// with input fields lifted from TenantGroupMemberAddInput.
func TestTenantGroupMemberAddWorkflow_InvokesActivity(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got AddGroupMemberSpiceDBInput
	var calls int
	env.RegisterActivityWithOptions(
		func(_ context.Context, input AddGroupMemberSpiceDBInput) error {
			calls++
			got = input
			return nil
		},
		registerAs("AddGroupMemberSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantGroupMemberAddWorkflow, TenantGroupMemberAddInput{
		TenantID: "tenant-1",
		GroupID:  "group-1",
		UserID:   "user-99",
		AddedBy:  "user-bb",
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
	want := AddGroupMemberSpiceDBInput{GroupID: "group-1", UserID: "user-99"}
	if got != want {
		t.Fatalf("activity input: got %+v, want %+v", got, want)
	}
}

// TestTenantGroupMemberAddWorkflow_PropagatesActivityError — error
// from the activity surfaces to the workflow caller.
func TestTenantGroupMemberAddWorkflow_PropagatesActivityError(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	sentinel := errors.New("spicedb: connection refused")
	env.RegisterActivityWithOptions(
		func(_ context.Context, _ AddGroupMemberSpiceDBInput) error {
			return sentinel
		},
		registerAs("AddGroupMemberSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantGroupMemberAddWorkflow, TenantGroupMemberAddInput{
		TenantID: "tenant-1", GroupID: "g1", UserID: "u1",
	})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	if err := env.GetWorkflowError(); err == nil {
		t.Fatalf("workflow should have propagated activity error")
	}
}

// TestTenantGroupMemberRemoveWorkflow_InvokesActivity — mirror of
// add for the reverse direction.
func TestTenantGroupMemberRemoveWorkflow_InvokesActivity(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got RemoveGroupMemberSpiceDBInput
	var calls int
	env.RegisterActivityWithOptions(
		func(_ context.Context, input RemoveGroupMemberSpiceDBInput) error {
			calls++
			got = input
			return nil
		},
		registerAs("RemoveGroupMemberSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantGroupMemberRemoveWorkflow, TenantGroupMemberRemoveInput{
		TenantID: "tenant-1", GroupID: "group-1", UserID: "user-99",
		RemovedBy: "user-bb",
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
	want := RemoveGroupMemberSpiceDBInput{GroupID: "group-1", UserID: "user-99"}
	if got != want {
		t.Fatalf("activity input: got %+v, want %+v", got, want)
	}
}
