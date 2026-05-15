package main

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/testsuite"

	auth "github.com/monok8s/monok8s/packages/auth/go"
)

// stubTenantRoleChanger — records args to WriteTenantRoleChanged.
// Satisfies tenantRoleChanger interface via structural typing.
type stubTenantRoleChanger struct {
	calls     []changeCall
	changeErr error
}

type changeCall struct {
	tenantID  string
	principal auth.Principal
	oldRole   string
	newRole   string
}

func (s *stubTenantRoleChanger) WriteTenantRoleChanged(_ context.Context, tenantID string, principal auth.Principal, oldRole, newRole string) (string, error) {
	s.calls = append(s.calls, changeCall{tenantID, principal, oldRole, newRole})
	return "zedtoken-test", s.changeErr
}

// TestChangeTenantRoleSpiceDBActivity_CallsChangerWithPrincipal —
// activity wires input fields into a Principal struct + dispatches to
// WriteTenantRoleChanged with both roles.
func TestChangeTenantRoleSpiceDBActivity_CallsChangerWithPrincipal(t *testing.T) {
	stub := &stubTenantRoleChanger{}
	setTenantRoleChangerForTesting(stub)
	t.Cleanup(func() { setTenantRoleChangerForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(ChangeTenantRoleSpiceDBActivity)

	_, err := env.ExecuteActivity(ChangeTenantRoleSpiceDBActivity,
		ChangeTenantRoleSpiceDBInput{
			TenantID:    "tenant-1",
			SubjectID:   "user-99",
			SubjectType: "user",
			OldRole:     "viewer",
			NewRole:     "admin",
		})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if len(stub.calls) != 1 {
		t.Fatalf("change calls: got %d, want 1", len(stub.calls))
	}
	got := stub.calls[0]
	want := changeCall{
		tenantID:  "tenant-1",
		principal: auth.Principal{Type: "user", ID: "user-99"},
		oldRole:   "viewer",
		newRole:   "admin",
	}
	if got != want {
		t.Fatalf("change call: got %+v, want %+v", got, want)
	}
}

// TestChangeTenantRoleSpiceDBActivity_ServiceAccountSubject — passes
// service_account SubjectType into the Principal.
func TestChangeTenantRoleSpiceDBActivity_ServiceAccountSubject(t *testing.T) {
	stub := &stubTenantRoleChanger{}
	setTenantRoleChangerForTesting(stub)
	t.Cleanup(func() { setTenantRoleChangerForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(ChangeTenantRoleSpiceDBActivity)

	_, err := env.ExecuteActivity(ChangeTenantRoleSpiceDBActivity,
		ChangeTenantRoleSpiceDBInput{
			TenantID:    "tenant-1",
			SubjectID:   "sa-1",
			SubjectType: "service_account",
			OldRole:     "viewer",
			NewRole:     "member",
		})
	if err != nil {
		t.Fatalf("activity error: %v", err)
	}
	if stub.calls[0].principal.Type != "service_account" {
		t.Fatalf("principal.Type: got %q, want service_account",
			stub.calls[0].principal.Type)
	}
}

// TestChangeTenantRoleSpiceDBActivity_PropagatesChangerError — writer
// errors surface to the activity caller.
func TestChangeTenantRoleSpiceDBActivity_PropagatesChangerError(t *testing.T) {
	sentinel := errors.New("spicedb: NamespaceNotFound")
	stub := &stubTenantRoleChanger{changeErr: sentinel}
	setTenantRoleChangerForTesting(stub)
	t.Cleanup(func() { setTenantRoleChangerForTesting(nil) })

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(ChangeTenantRoleSpiceDBActivity)

	_, err := env.ExecuteActivity(ChangeTenantRoleSpiceDBActivity,
		ChangeTenantRoleSpiceDBInput{
			TenantID: "tenant-1", SubjectID: "user-99", SubjectType: "user",
			OldRole: "viewer", NewRole: "admin",
		})
	if err == nil {
		t.Fatalf("expected activity to propagate changer error")
	}
}
