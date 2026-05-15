package main

import (
	"context"
	"errors"
	"sync"
	"testing"

	"go.temporal.io/sdk/testsuite"
)

// TestOnboardTenantWorkflow_ActivityOrder asserts the workflow invokes
// activities in the exact order required by Issue #84's AC:
//
//	1. ProvisionNamespaceActivity   (Capsule tenant CR, #81)
//	2. ProvisionDatabaseActivity    (per-tenant Postgres, #82)
//	3. MintTenantVaultKeyActivity   (Vault transit key, #83)
//	4. RunMigrationsActivity        (Atlas migrations, #86)
//	5. EmitTenantCreatedEventActivity (NATS publish)
//
// All activities are mocked to return nil success so the workflow
// reaches the end. The order is captured in a slice; the test asserts
// the slice matches the AC sequence exactly.
func TestOnboardTenantWorkflow_ActivityOrder(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var mu sync.Mutex
	var calls []string
	record := func(name string) func(context.Context, string) error {
		return func(_ context.Context, _ string) error {
			mu.Lock()
			calls = append(calls, name)
			mu.Unlock()
			return nil
		}
	}
	env.RegisterActivityWithOptions(record("ProvisionNamespaceActivity"),
		registerAs("ProvisionNamespaceActivity"))
	env.RegisterActivityWithOptions(record("ProvisionDatabaseActivity"),
		registerAs("ProvisionDatabaseActivity"))
	env.RegisterActivityWithOptions(record("MintTenantVaultKeyActivity"),
		registerAs("MintTenantVaultKeyActivity"))
	env.RegisterActivityWithOptions(record("RunMigrationsActivity"),
		registerAs("RunMigrationsActivity"))
	env.RegisterActivityWithOptions(record("EmitTenantCreatedEventActivity"),
		registerAs("EmitTenantCreatedEventActivity"))

	env.ExecuteWorkflow(OnboardTenantWorkflow, TenantInput{TenantID: "acme"})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("workflow error: %v", err)
	}

	expected := []string{
		"ProvisionNamespaceActivity",
		"ProvisionDatabaseActivity",
		"MintTenantVaultKeyActivity",
		"RunMigrationsActivity",
		"EmitTenantCreatedEventActivity",
	}
	if len(calls) != len(expected) {
		t.Fatalf("activity count: got %d, want %d (calls: %v)", len(calls), len(expected), calls)
	}
	for i, want := range expected {
		if calls[i] != want {
			t.Errorf("step %d: got %q, want %q", i+1, calls[i], want)
		}
	}
}

// TestOnboardTenantWorkflow_PropagatesActivityError asserts that when
// any activity returns an error the workflow propagates it AND
// subsequent activities are not invoked. Exercises the error-path the
// stub activities return today.
func TestOnboardTenantWorkflow_PropagatesActivityError(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var mu sync.Mutex
	var calls []string
	sentinel := errors.New("step 2 failed")

	record := func(name string, err error) func(context.Context, string) error {
		return func(_ context.Context, _ string) error {
			mu.Lock()
			calls = append(calls, name)
			mu.Unlock()
			return err
		}
	}
	env.RegisterActivityWithOptions(record("ProvisionNamespaceActivity", nil),
		registerAs("ProvisionNamespaceActivity"))
	env.RegisterActivityWithOptions(record("ProvisionDatabaseActivity", sentinel),
		registerAs("ProvisionDatabaseActivity"))
	env.RegisterActivityWithOptions(record("MintTenantVaultKeyActivity", nil),
		registerAs("MintTenantVaultKeyActivity"))
	env.RegisterActivityWithOptions(record("RunMigrationsActivity", nil),
		registerAs("RunMigrationsActivity"))
	env.RegisterActivityWithOptions(record("EmitTenantCreatedEventActivity", nil),
		registerAs("EmitTenantCreatedEventActivity"))

	env.ExecuteWorkflow(OnboardTenantWorkflow, TenantInput{TenantID: "acme"})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	wfErr := env.GetWorkflowError()
	if wfErr == nil {
		t.Fatalf("workflow error: got nil, want error containing %q", sentinel.Error())
	}
	// Temporal wraps activity errors; the wrapped chain should reach
	// our sentinel.
	var found bool
	for err := wfErr; err != nil; err = errors.Unwrap(err) {
		if err.Error() == sentinel.Error() {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("workflow error chain doesn't contain sentinel: %v", wfErr)
	}

	// Steps 3-5 must NOT have been invoked. Reduce `calls` to the
	// unique-name set — Temporal's default retry policy invokes the
	// erroring activity multiple times before giving up, which is
	// expected production behavior. The test's invariant is "no
	// downstream step was reached", which is captured by the unique
	// set, not the raw count.
	seen := map[string]bool{}
	for _, c := range calls {
		seen[c] = true
	}
	if len(seen) != 2 || !seen["ProvisionNamespaceActivity"] || !seen["ProvisionDatabaseActivity"] {
		t.Errorf("unique activities reached: got %v, want {ProvisionNamespaceActivity, ProvisionDatabaseActivity}", seen)
	}
	// Order check on the first two unique invocations: namespace must
	// have completed before database started.
	if calls[0] != "ProvisionNamespaceActivity" {
		t.Errorf("first activity: got %q, want ProvisionNamespaceActivity", calls[0])
	}
	if calls[1] != "ProvisionDatabaseActivity" {
		t.Errorf("second activity (first retry of the failing step): got %q, want ProvisionDatabaseActivity", calls[1])
	}
}

// TestOnboardTenantWorkflow_CompensatesOnFailure asserts that when a
// forward activity fails after step 1, the workflow invokes cleanup
// activities in reverse order of completion + finally
// EmitTenantCreationFailedEventActivity. Injects an error at step 4
// (RunMigrationsActivity). Expected unique-name call set, in order
// of first occurrence:
//
//	ProvisionNamespaceActivity, ProvisionDatabaseActivity,
//	MintTenantVaultKeyActivity, RunMigrationsActivity (fails),
//	DeleteTenantVaultKeyActivity, DeleteTenantDatabaseActivity,
//	DeleteTenantNamespaceActivity, EmitTenantCreationFailedEventActivity
//
// Migrations step has no cleanup activity (Atlas no-rollback Gap).
// Uses the unique-name reduction idiom (also used by
// PropagatesActivityError) because Temporal's default retry policy
// retries the failing activity multiple times.
func TestOnboardTenantWorkflow_CompensatesOnFailure(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()

	var mu sync.Mutex
	var calls []string
	sentinel := errors.New("step 4 migrations failed")

	record := func(name string, err error) func(context.Context, string) error {
		return func(_ context.Context, _ string) error {
			mu.Lock()
			calls = append(calls, name)
			mu.Unlock()
			return err
		}
	}
	// Forward activities: 1-3 succeed, 4 fails, 5 not reached.
	env.RegisterActivityWithOptions(record("ProvisionNamespaceActivity", nil),
		registerAs("ProvisionNamespaceActivity"))
	env.RegisterActivityWithOptions(record("ProvisionDatabaseActivity", nil),
		registerAs("ProvisionDatabaseActivity"))
	env.RegisterActivityWithOptions(record("MintTenantVaultKeyActivity", nil),
		registerAs("MintTenantVaultKeyActivity"))
	env.RegisterActivityWithOptions(record("RunMigrationsActivity", sentinel),
		registerAs("RunMigrationsActivity"))
	env.RegisterActivityWithOptions(record("EmitTenantCreatedEventActivity", nil),
		registerAs("EmitTenantCreatedEventActivity"))
	// Cleanup activities.
	env.RegisterActivityWithOptions(record("DeleteTenantNamespaceActivity", nil),
		registerAs("DeleteTenantNamespaceActivity"))
	env.RegisterActivityWithOptions(record("DeleteTenantDatabaseActivity", nil),
		registerAs("DeleteTenantDatabaseActivity"))
	env.RegisterActivityWithOptions(record("DeleteTenantVaultKeyActivity", nil),
		registerAs("DeleteTenantVaultKeyActivity"))
	env.RegisterActivityWithOptions(record("EmitTenantCreationFailedEventActivity", nil),
		registerAs("EmitTenantCreationFailedEventActivity"))

	env.ExecuteWorkflow(OnboardTenantWorkflow, TenantInput{TenantID: "acme"})

	if !env.IsWorkflowCompleted() {
		t.Fatalf("workflow not completed")
	}
	wfErr := env.GetWorkflowError()
	if wfErr == nil {
		t.Fatalf("workflow error: got nil, want error from step 4")
	}

	// Reduce to first-occurrence-of-each-unique-name sequence; Temporal
	// retry policy re-invokes the failing activity multiple times.
	seenIdx := map[string]int{}
	for i, c := range calls {
		if _, ok := seenIdx[c]; !ok {
			seenIdx[c] = i
		}
	}

	// Forward order: 1-4 invoked, 5 never (5 is the success-path emit).
	wantInvoked := []string{
		"ProvisionNamespaceActivity",
		"ProvisionDatabaseActivity",
		"MintTenantVaultKeyActivity",
		"RunMigrationsActivity",
		// then cleanup in reverse:
		"DeleteTenantVaultKeyActivity",
		"DeleteTenantDatabaseActivity",
		"DeleteTenantNamespaceActivity",
		// then failure event:
		"EmitTenantCreationFailedEventActivity",
	}
	for _, want := range wantInvoked {
		if _, ok := seenIdx[want]; !ok {
			t.Errorf("expected activity %q to have been invoked; never was. calls=%v", want, calls)
		}
	}
	// Success-path emit must never be invoked on the failure path.
	if _, ok := seenIdx["EmitTenantCreatedEventActivity"]; ok {
		t.Errorf("EmitTenantCreatedEventActivity invoked on failure path; should not be")
	}

	// First-occurrence-ordering: each later entry's first index is
	// strictly greater than the previous's.
	for i := 1; i < len(wantInvoked); i++ {
		if seenIdx[wantInvoked[i]] <= seenIdx[wantInvoked[i-1]] {
			t.Errorf("order violation: %q (first at %d) should come after %q (first at %d). calls=%v",
				wantInvoked[i], seenIdx[wantInvoked[i]],
				wantInvoked[i-1], seenIdx[wantInvoked[i-1]],
				calls)
		}
	}
}

// registerAs returns Temporal's RegisterActivityOptions configured so
// the mock activity registers under the named identifier — required
// because the workflow refers to activities by function pointer, but
// the testsuite needs an explicit name to match registrations against
// the workflow's ExecuteActivity calls.
func registerAs(name string) registerOpts {
	return registerOpts{Name: name}
}

// registerOpts is a tiny type alias re-export of activity.RegisterOptions
// — kept local to avoid importing the activity package solely for the
// options struct.
type registerOpts = struct {
	Name                          string
	DisableAlreadyRegisteredCheck bool
	SkipInvalidStructFunctions    bool
}
