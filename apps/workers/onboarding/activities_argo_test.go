package main

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"go.temporal.io/sdk/testsuite"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

// startInProcessNATSForArgo spins up a hermetic nats-server. Same
// shape as activities_emit_test.go's helper — separate function only
// to avoid coupling the two test files into a shared package.
func startInProcessNATSForArgo(t *testing.T) (string, func()) {
	t.Helper()
	opts := &natsserver.Options{
		Host:           "127.0.0.1",
		Port:           -1,
		NoLog:          true,
		NoSigs:         true,
		MaxControlLine: 4096,
	}
	s, err := natsserver.NewServer(opts)
	if err != nil {
		t.Fatalf("nats-server NewServer: %v", err)
	}
	go s.Start()
	if !s.ReadyForConnections(5 * time.Second) {
		s.Shutdown()
		t.Fatal("nats-server: not ready after 5s")
	}
	return s.ClientURL(), s.Shutdown
}

// withFakeDynamicClientForArgo installs a NewSimpleDynamicClient-backed
// factory with the WorkflowList kind registered, returning the fake
// client + a cleanup func to restore package-var defaults.
func withFakeDynamicClientForArgo(t *testing.T) (*dynamicfake.FakeDynamicClient, func()) {
	t.Helper()
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "argoproj.io", Version: "v1alpha1", Kind: "WorkflowList"},
		&unstructured.UnstructuredList{},
	)
	fake := dynamicfake.NewSimpleDynamicClient(scheme)

	origFactory := dynamicClientFactory
	dynamicClientFactory = func() (dynamic.Interface, error) { return fake, nil }

	return fake, func() {
		dynamicClientFactory = origFactory
	}
}

// publishAfter spawns a goroutine that publishes phase on subject in
// a retry loop for up to 5s. Retrying handles the race where the
// activity's subscriber interest hasn't yet propagated through the
// in-process server at the moment of the first publish — NATS core
// drops messages with no matching subscriber, so a one-shot publish
// can be silently lost. The activity returns on the first successful
// delivery; subsequent retries reach a closed subscription and are
// harmless.
func publishAfter(t *testing.T, url, subject, phase string, delay time.Duration, wg *sync.WaitGroup) {
	t.Helper()
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(delay)
		nc, err := nats.Connect(url, nats.Timeout(2*time.Second))
		if err != nil {
			t.Errorf("publishAfter connect: %v", err)
			return
		}
		defer nc.Close()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if err := nc.Publish(subject, []byte(phase)); err != nil {
				t.Errorf("publishAfter publish: %v", err)
				return
			}
			if err := nc.Flush(); err != nil {
				t.Errorf("publishAfter flush: %v", err)
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}()
}

// assertOneWorkflowCreated reads the fake client's Workflow list and
// asserts exactly one CR exists with the expected workflowTemplateRef
// name and tenantId argument.
func assertOneWorkflowCreated(t *testing.T, fake *dynamicfake.FakeDynamicClient, wantTemplate, wantTenantID string) {
	t.Helper()
	list, err := fake.Resource(workflowGVR).Namespace(argoNamespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list Workflows: %v", err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("Workflow CR count: got %d, want 1", len(list.Items))
	}
	wf := list.Items[0]
	ref, _, _ := unstructured.NestedString(wf.Object, "spec", "workflowTemplateRef", "name")
	if ref != wantTemplate {
		t.Errorf("workflowTemplateRef.name: got %q, want %q", ref, wantTemplate)
	}
	params, found, err := unstructured.NestedSlice(wf.Object, "spec", "arguments", "parameters")
	if err != nil || !found {
		t.Fatalf("spec.arguments.parameters: not found (err=%v)", err)
	}
	if len(params) != 1 {
		t.Fatalf("parameters length: got %d, want 1", len(params))
	}
	p, ok := params[0].(map[string]any)
	if !ok {
		t.Fatalf("parameter[0] type: got %T, want map[string]any", params[0])
	}
	if p["name"] != "tenantId" {
		t.Errorf("parameter[0].name: got %v, want tenantId", p["name"])
	}
	if p["value"] != wantTenantID {
		t.Errorf("parameter[0].value: got %v, want %q", p["value"], wantTenantID)
	}
	ns := wf.GetNamespace()
	if ns != argoNamespace {
		t.Errorf("Workflow namespace: got %q, want %q", ns, argoNamespace)
	}
}

// TestMintTenantVaultKeyActivity_Succeeds drives the activity end-to-end:
// in-process NATS + fake dynamic client + a publisher that simulates
// Argo's onExit step. Asserts the activity returns nil, the Workflow
// CR was submitted with the right template ref + parameters.
func TestMintTenantVaultKeyActivity_Succeeds(t *testing.T) {
	url, shutdown := startInProcessNATSForArgo(t)
	defer shutdown()
	t.Setenv("NATS_URL", url)

	fake, cleanup := withFakeDynamicClientForArgo(t)
	defer cleanup()

	var wg sync.WaitGroup
	publishAfter(t, url, "workflow.tenant.acme.mint-vault-key", "Succeeded", 50*time.Millisecond, &wg)

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(MintTenantVaultKeyActivity)
	if _, err := env.ExecuteActivity(MintTenantVaultKeyActivity, "acme"); err != nil {
		t.Fatalf("MintTenantVaultKeyActivity: %v", err)
	}
	wg.Wait()

	assertOneWorkflowCreated(t, fake, "mint-tenant-vault-key", "acme")
}

// TestRunMigrationsActivity_Succeeds — same shape against
// apply-tenant-migrations + the migrations subject.
func TestRunMigrationsActivity_Succeeds(t *testing.T) {
	url, shutdown := startInProcessNATSForArgo(t)
	defer shutdown()
	t.Setenv("NATS_URL", url)

	fake, cleanup := withFakeDynamicClientForArgo(t)
	defer cleanup()

	var wg sync.WaitGroup
	publishAfter(t, url, "workflow.tenant.acme.migrations", "Succeeded", 50*time.Millisecond, &wg)

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(RunMigrationsActivity)
	if _, err := env.ExecuteActivity(RunMigrationsActivity, "acme"); err != nil {
		t.Fatalf("RunMigrationsActivity: %v", err)
	}
	wg.Wait()

	assertOneWorkflowCreated(t, fake, "apply-tenant-migrations", "acme")
}

// TestSubmitArgoWorkflowAndWait_PropagatesFailedPhase asserts a
// non-Succeeded callback (Argo phase Failed) surfaces as an activity
// error containing the phase string. The helper returns the inner
// error rather than the Temporal-wrapped one — testsuite preserves
// the raw error message in the failure detail, which we substring-match.
func TestSubmitArgoWorkflowAndWait_PropagatesFailedPhase(t *testing.T) {
	url, shutdown := startInProcessNATSForArgo(t)
	defer shutdown()
	t.Setenv("NATS_URL", url)

	_, cleanup := withFakeDynamicClientForArgo(t)
	defer cleanup()

	var wg sync.WaitGroup
	publishAfter(t, url, "workflow.tenant.acme.migrations", "Failed", 50*time.Millisecond, &wg)

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(RunMigrationsActivity)
	_, err := env.ExecuteActivity(RunMigrationsActivity, "acme")
	wg.Wait()
	if err == nil {
		t.Fatal("got nil error, want phase=Failed propagation")
	}
	if !strings.Contains(err.Error(), "Failed") {
		t.Errorf("error message missing phase: %q", err.Error())
	}
}

// TestSubmitArgoWorkflowAndWait_TimesOut asserts the deadline path
// fires when no callback arrives. Overrides argoWaitTimeout +
// natsHeartbeatInterval to ~50 ms to keep the test fast.
func TestSubmitArgoWorkflowAndWait_TimesOut(t *testing.T) {
	url, shutdown := startInProcessNATSForArgo(t)
	defer shutdown()
	t.Setenv("NATS_URL", url)

	_, cleanup := withFakeDynamicClientForArgo(t)
	defer cleanup()

	origTimeout := argoWaitTimeout
	origHeartbeat := natsHeartbeatInterval
	argoWaitTimeout = 100 * time.Millisecond
	natsHeartbeatInterval = 30 * time.Millisecond
	defer func() {
		argoWaitTimeout = origTimeout
		natsHeartbeatInterval = origHeartbeat
	}()

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(RunMigrationsActivity)
	_, err := env.ExecuteActivity(RunMigrationsActivity, "stalled")
	if err == nil {
		t.Fatal("got nil error, want timeout")
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Errorf("error message missing 'timed out': %q", err.Error())
	}
}

// TestMintTenantVaultKeyActivity_EmptyTenantID — validation guard
// fires synchronously before any NATS / k8s interaction.
func TestMintTenantVaultKeyActivity_EmptyTenantID(t *testing.T) {
	if err := MintTenantVaultKeyActivity(context.Background(), ""); err == nil {
		t.Fatal("got nil error for empty tenantID, want validation error")
	}
}

// TestRunMigrationsActivity_EmptyTenantID — same guard for the
// migrations activity.
func TestRunMigrationsActivity_EmptyTenantID(t *testing.T) {
	if err := RunMigrationsActivity(context.Background(), ""); err == nil {
		t.Fatal("got nil error for empty tenantID, want validation error")
	}
}
