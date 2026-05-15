package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"

	auth "github.com/monok8s/monok8s/packages/auth/go"
)

// stubTenantRoleWriter records the args passed to its Write* methods
// + returns canned values. Satisfies the tenantRoleWriter interface
// via structural typing.
type stubTenantRoleWriter struct {
	assignCalls   []writeCall
	unassignCalls []writeCall
	assignErr     error
	unassignErr   error
}

type writeCall struct {
	tenantID  string
	principal auth.Principal
	role      string
}

func (s *stubTenantRoleWriter) WriteTenantRoleAssigned(_ context.Context, tenantID string, principal auth.Principal, role string) (string, error) {
	s.assignCalls = append(s.assignCalls, writeCall{tenantID, principal, role})
	return "zedtoken-test", s.assignErr
}

func (s *stubTenantRoleWriter) WriteTenantRoleUnassigned(_ context.Context, tenantID string, principal auth.Principal, role string) (string, error) {
	s.unassignCalls = append(s.unassignCalls, writeCall{tenantID, principal, role})
	return "zedtoken-test", s.unassignErr
}

// TestAssignTenantRoleSpiceDBActivity_CallsWriterWithPrincipal —
// activity wires the input fields into a Principal struct and dispatches
// the user-case to WriteTenantRoleAssigned.
func TestAssignTenantRoleSpiceDBActivity_CallsWriterWithPrincipal(t *testing.T) {
	stub := &stubTenantRoleWriter{}
	setTenantRoleWriterForTesting(stub)
	t.Cleanup(func() { setTenantRoleWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(AssignTenantRoleSpiceDBActivity)

	_, err := env.ExecuteActivity(AssignTenantRoleSpiceDBActivity,
		AssignTenantRoleSpiceDBInput{
			TenantID:    "tenant-1",
			SubjectID:   "user-99",
			SubjectType: "user",
			Role:        "admin",
		})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if len(stub.assignCalls) != 1 {
		t.Fatalf("assign calls: got %d, want 1", len(stub.assignCalls))
	}
	got := stub.assignCalls[0]
	want := writeCall{
		tenantID:  "tenant-1",
		principal: auth.Principal{Type: "user", ID: "user-99"},
		role:      "admin",
	}
	if got != want {
		t.Fatalf("write call: got %+v, want %+v", got, want)
	}
}

// TestAssignTenantRoleSpiceDBActivity_ServiceAccountSubject — activity
// passes through service_account SubjectType into the Principal.
func TestAssignTenantRoleSpiceDBActivity_ServiceAccountSubject(t *testing.T) {
	stub := &stubTenantRoleWriter{}
	setTenantRoleWriterForTesting(stub)
	t.Cleanup(func() { setTenantRoleWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(AssignTenantRoleSpiceDBActivity)

	_, err := env.ExecuteActivity(AssignTenantRoleSpiceDBActivity,
		AssignTenantRoleSpiceDBInput{
			TenantID:    "tenant-1",
			SubjectID:   "sa-1",
			SubjectType: "service_account",
			Role:        "member",
		})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if stub.assignCalls[0].principal.Type != "service_account" {
		t.Fatalf("principal.Type: got %q, want service_account",
			stub.assignCalls[0].principal.Type)
	}
}

// TestAssignTenantRoleSpiceDBActivity_PropagatesWriterError — writer
// failures surface to the activity.
func TestAssignTenantRoleSpiceDBActivity_PropagatesWriterError(t *testing.T) {
	sentinel := errors.New("spicedb: NamespaceNotFound")
	stub := &stubTenantRoleWriter{assignErr: sentinel}
	setTenantRoleWriterForTesting(stub)
	t.Cleanup(func() { setTenantRoleWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(AssignTenantRoleSpiceDBActivity)

	_, err := env.ExecuteActivity(AssignTenantRoleSpiceDBActivity,
		AssignTenantRoleSpiceDBInput{
			TenantID: "tenant-1", SubjectID: "user-99", SubjectType: "user", Role: "admin",
		})
	if err == nil {
		t.Fatalf("expected activity to propagate writer error")
	}
}

// TestUnassignTenantRoleSpiceDBActivity_CallsUnassignWriter — mirror
// of the assign test for the reverse direction.
func TestUnassignTenantRoleSpiceDBActivity_CallsUnassignWriter(t *testing.T) {
	stub := &stubTenantRoleWriter{}
	setTenantRoleWriterForTesting(stub)
	t.Cleanup(func() { setTenantRoleWriterForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(UnassignTenantRoleSpiceDBActivity)

	_, err := env.ExecuteActivity(UnassignTenantRoleSpiceDBActivity,
		UnassignTenantRoleSpiceDBInput{
			TenantID:    "tenant-1",
			SubjectID:   "user-99",
			SubjectType: "user",
			Role:        "admin",
		})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if len(stub.unassignCalls) != 1 {
		t.Fatalf("unassign calls: got %d, want 1", len(stub.unassignCalls))
	}
	// Assign path should NOT have fired.
	if len(stub.assignCalls) != 0 {
		t.Fatalf("assign calls should be 0 for unassign activity, got %d",
			len(stub.assignCalls))
	}
}
