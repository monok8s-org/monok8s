package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

// Local re-declaration of registerAs — each Bazel go_test is its own
// compile unit; see workflow_assign_role_test.go for the rationale.
type registerOptsCR = struct {
	Name                          string
	DisableAlreadyRegisteredCheck bool
	SkipInvalidStructFunctions    bool
}

func registerAs(name string) registerOptsCR {
	return registerOptsCR{Name: name}
}

// TestTenantRoleChangeWorkflow_InvokesActivity asserts the workflow
// dispatches ChangeTenantRoleSpiceDBActivity exactly once with input
// fields lifted from TenantRoleChangeInput.
func TestTenantRoleChangeWorkflow_InvokesActivity(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got ChangeTenantRoleSpiceDBInput
	var calls int
	env.RegisterActivityWithOptions(
		func(_ context.Context, input ChangeTenantRoleSpiceDBInput) error {
			calls++
			got = input
			return nil
		},
		registerAs("ChangeTenantRoleSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantRoleChangeWorkflow, TenantRoleChangeInput{
		TenantID:    "tenant-1",
		SubjectID:   "user-99",
		SubjectType: "user",
		OldRole:     "viewer",
		NewRole:     "admin",
		ChangedBy:   "user-bb",
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
	want := ChangeTenantRoleSpiceDBInput{
		TenantID:    "tenant-1",
		SubjectID:   "user-99",
		SubjectType: "user",
		OldRole:     "viewer",
		NewRole:     "admin",
	}
	if got != want {
		t.Fatalf("activity input: got %+v, want %+v", got, want)
	}
}

// TestTenantRoleChangeWorkflow_ServiceAccountSubject — assert the
// SubjectType passes through for non-user principals.
func TestTenantRoleChangeWorkflow_ServiceAccountSubject(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got ChangeTenantRoleSpiceDBInput
	env.RegisterActivityWithOptions(
		func(_ context.Context, input ChangeTenantRoleSpiceDBInput) error {
			got = input
			return nil
		},
		registerAs("ChangeTenantRoleSpiceDBActivity"),
	)
	env.ExecuteWorkflow(TenantRoleChangeWorkflow, TenantRoleChangeInput{
		TenantID:    "tenant-1",
		SubjectID:   "sa-1",
		SubjectType: "service_account",
		OldRole:     "viewer",
		NewRole:     "member",
	})

	if got.SubjectType != "service_account" {
		t.Fatalf("SubjectType: got %q, want service_account", got.SubjectType)
	}
}

// TestTenantRoleChangeWorkflow_PropagatesActivityError — error from
// the activity surfaces to the workflow caller.
func TestTenantRoleChangeWorkflow_PropagatesActivityError(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	sentinel := errors.New("spicedb: connection refused")
	env.RegisterActivityWithOptions(
		func(_ context.Context, _ ChangeTenantRoleSpiceDBInput) error {
			return sentinel
		},
		registerAs("ChangeTenantRoleSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantRoleChangeWorkflow, TenantRoleChangeInput{
		TenantID: "tenant-1", SubjectID: "user-99", SubjectType: "user",
		OldRole: "viewer", NewRole: "admin",
	})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	if err := env.GetWorkflowError(); err == nil {
		t.Fatalf("workflow should have propagated activity error")
	}
}
