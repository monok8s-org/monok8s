package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

// Local re-declaration of the registerAs helper from workflow_test.go.
// Each Bazel go_test target is its own compile unit, so the helper
// isn't shared across targets. Same shape — tiny type alias around
// Temporal's activity.RegisterOptions.
type registerOptsAR = struct {
	Name                          string
	DisableAlreadyRegisteredCheck bool
	SkipInvalidStructFunctions    bool
}

func registerAs(name string) registerOptsAR {
	return registerOptsAR{Name: name}
}

// TestTenantRoleAssignWorkflow_InvokesActivity asserts the workflow
// dispatches AssignTenantRoleSpiceDBActivity exactly once with input
// fields lifted from TenantRoleAssignInput.
func TestTenantRoleAssignWorkflow_InvokesActivity(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got AssignTenantRoleSpiceDBInput
	var calls int
	env.RegisterActivityWithOptions(
		func(_ context.Context, input AssignTenantRoleSpiceDBInput) error {
			calls++
			got = input
			return nil
		},
		registerAs("AssignTenantRoleSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantRoleAssignWorkflow, TenantRoleAssignInput{
		TenantID:    "tenant-1",
		SubjectID:   "user-99",
		SubjectType: "user",
		Role:        "admin",
		AssignedBy:  "user-bb",
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
	want := AssignTenantRoleSpiceDBInput{
		TenantID:    "tenant-1",
		SubjectID:   "user-99",
		SubjectType: "user",
		Role:        "admin",
	}
	if got != want {
		t.Fatalf("activity input: got %+v, want %+v", got, want)
	}
}

// TestTenantRoleAssignWorkflow_PropagatesActivityError — workflow
// surfaces the activity's error rather than swallowing it.
func TestTenantRoleAssignWorkflow_PropagatesActivityError(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	sentinel := errors.New("spicedb: connection refused")
	env.RegisterActivityWithOptions(
		func(_ context.Context, _ AssignTenantRoleSpiceDBInput) error {
			return sentinel
		},
		registerAs("AssignTenantRoleSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantRoleAssignWorkflow, TenantRoleAssignInput{
		TenantID: "tenant-1", SubjectID: "user-99", SubjectType: "user", Role: "admin",
	})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	if err := env.GetWorkflowError(); err == nil {
		t.Fatalf("workflow should have propagated activity error")
	}
}

// TestTenantRoleAssignWorkflow_ServiceAccountSubject — assert the
// SubjectType field carries through to the activity for non-user
// principals.
func TestTenantRoleAssignWorkflow_ServiceAccountSubject(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got AssignTenantRoleSpiceDBInput
	env.RegisterActivityWithOptions(
		func(_ context.Context, input AssignTenantRoleSpiceDBInput) error {
			got = input
			return nil
		},
		registerAs("AssignTenantRoleSpiceDBActivity"),
	)
	env.ExecuteWorkflow(TenantRoleAssignWorkflow, TenantRoleAssignInput{
		TenantID:    "tenant-1",
		SubjectID:   "sa-1",
		SubjectType: "service_account",
		Role:        "member",
	})

	if got.SubjectType != "service_account" {
		t.Fatalf("SubjectType: got %q, want service_account", got.SubjectType)
	}
}

// TestTenantRoleUnassignWorkflow_InvokesActivity — mirror of the
// assign test for the reverse direction.
func TestTenantRoleUnassignWorkflow_InvokesActivity(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var got UnassignTenantRoleSpiceDBInput
	var calls int
	env.RegisterActivityWithOptions(
		func(_ context.Context, input UnassignTenantRoleSpiceDBInput) error {
			calls++
			got = input
			return nil
		},
		registerAs("UnassignTenantRoleSpiceDBActivity"),
	)

	env.ExecuteWorkflow(TenantRoleUnassignWorkflow, TenantRoleUnassignInput{
		TenantID:    "tenant-1",
		SubjectID:   "user-99",
		SubjectType: "user",
		Role:        "admin",
		UnassignedBy: "user-bb",
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
	want := UnassignTenantRoleSpiceDBInput{
		TenantID: "tenant-1", SubjectID: "user-99", SubjectType: "user", Role: "admin",
	}
	if got != want {
		t.Fatalf("activity input: got %+v, want %+v", got, want)
	}
}
