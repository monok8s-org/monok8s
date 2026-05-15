package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"go.temporal.io/sdk/testsuite"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

// withFakeDynamicClient installs a NewSimpleDynamicClient-backed
// factory + a short pollInterval for the test's lifetime. Returns the
// fake client + a cleanup func to restore the package-var defaults.
func withFakeDynamicClient(t *testing.T) (*dynamicfake.FakeDynamicClient, func()) {
	t.Helper()

	scheme := runtime.NewScheme()
	// Register list kinds for both XR GVRs so the fake client knows
	// how to construct list objects. Required by NewSimpleDynamicClient.
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "monok8s.io", Version: "v1alpha1", Kind: "XTenantList"},
		&unstructured.UnstructuredList{},
	)
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "monok8s.io", Version: "v1alpha1", Kind: "XTenantDatabaseList"},
		&unstructured.UnstructuredList{},
	)

	fake := dynamicfake.NewSimpleDynamicClient(scheme)

	origFactory := dynamicClientFactory
	origInterval := pollInterval
	dynamicClientFactory = func() (dynamic.Interface, error) { return fake, nil }
	pollInterval = 10 * time.Millisecond

	return fake, func() {
		dynamicClientFactory = origFactory
		pollInterval = origInterval
	}
}

// markReady simulates Crossplane reconciling the XR by patching
// status.ready=true after a short delay.
func markReady(t *testing.T, fake *dynamicfake.FakeDynamicClient, gvr schema.GroupVersionResource, name string, delay time.Duration, wg *sync.WaitGroup) {
	t.Helper()
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(delay)

		// Loop a few times to handle the race where the activity hasn't
		// yet created the XR.
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			current, err := fake.Resource(gvr).Get(context.Background(), name, metav1.GetOptions{})
			if err == nil {
				if err := unstructured.SetNestedField(current.Object, true, "status", "ready"); err != nil {
					t.Errorf("SetNestedField: %v", err)
					return
				}
				_, err := fake.Resource(gvr).Update(context.Background(), current, metav1.UpdateOptions{})
				if err == nil {
					return
				}
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Errorf("markReady: failed to find + update XR %s/%s within 2s", gvr.Resource, name)
	}()
}

// TestProvisionNamespaceActivity_Succeeds runs the activity against a
// fake dynamic client + a goroutine that simulates Crossplane
// reconcile by patching status.ready=true. Asserts:
//   - the activity returns nil
//   - the XR's spec.name + spec.postgresVersion + compositionSelector
//     are correctly populated on the applied object
func TestProvisionNamespaceActivity_Succeeds(t *testing.T) {
	fake, cleanup := withFakeDynamicClient(t)
	defer cleanup()

	var wg sync.WaitGroup
	markReady(t, fake, xtenantGVR, "acme", 50*time.Millisecond, &wg)

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(ProvisionNamespaceActivity)
	if _, err := env.ExecuteActivity(ProvisionNamespaceActivity, "acme"); err != nil {
		t.Fatalf("ProvisionNamespaceActivity: %v", err)
	}
	wg.Wait()

	// Inspect the applied object.
	current, err := fake.Resource(xtenantGVR).Get(context.Background(), "acme", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("Get XTenant: %v", err)
	}
	name, _, _ := unstructured.NestedString(current.Object, "spec", "name")
	if name != "acme" {
		t.Errorf("spec.name: got %q, want %q", name, "acme")
	}
	pgver, _, _ := unstructured.NestedString(current.Object, "spec", "postgresVersion")
	if pgver != "16" {
		t.Errorf("spec.postgresVersion: got %q, want %q", pgver, "16")
	}
	provider, _, _ := unstructured.NestedString(current.Object, "spec", "compositionSelector", "matchLabels", "monok8s.io/provider")
	if provider != "capsule" {
		t.Errorf("compositionSelector provider: got %q, want %q", provider, "capsule")
	}
}

// TestProvisionDatabaseActivity_Succeeds — same shape against
// XTenantDatabase. Asserts the per-tenant DB spec fields (engine,
// storage, dbName, tenantName).
func TestProvisionDatabaseActivity_Succeeds(t *testing.T) {
	fake, cleanup := withFakeDynamicClient(t)
	defer cleanup()

	var wg sync.WaitGroup
	markReady(t, fake, xtenantdatabaseGVR, "acme-app", 50*time.Millisecond, &wg)

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(ProvisionDatabaseActivity)
	if _, err := env.ExecuteActivity(ProvisionDatabaseActivity, "acme"); err != nil {
		t.Fatalf("ProvisionDatabaseActivity: %v", err)
	}
	wg.Wait()

	current, err := fake.Resource(xtenantdatabaseGVR).Get(context.Background(), "acme-app", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("Get XTenantDatabase: %v", err)
	}
	tenant, _, _ := unstructured.NestedString(current.Object, "spec", "tenantName")
	if tenant != "acme" {
		t.Errorf("spec.tenantName: got %q, want %q", tenant, "acme")
	}
	engine, _, _ := unstructured.NestedString(current.Object, "spec", "engine")
	if engine != "cnpg" {
		t.Errorf("spec.engine: got %q, want %q", engine, "cnpg")
	}
	storage, _, _ := unstructured.NestedString(current.Object, "spec", "storage")
	if storage != "medium" {
		t.Errorf("spec.storage: got %q, want %q", storage, "medium")
	}
	dbName, _, _ := unstructured.NestedString(current.Object, "spec", "dbName")
	if dbName != "app" {
		t.Errorf("spec.dbName: got %q, want %q", dbName, "app")
	}
	provider, _, _ := unstructured.NestedString(current.Object, "spec", "compositionSelector", "matchLabels", "monok8s.io/provider")
	if provider != "cnpg" {
		t.Errorf("compositionSelector provider: got %q, want %q", provider, "cnpg")
	}
}

// TestProvisionNamespaceActivity_EmptyTenantID asserts the validation
// guard fires before any client interaction.
func TestProvisionNamespaceActivity_EmptyTenantID(t *testing.T) {
	_, cleanup := withFakeDynamicClient(t)
	defer cleanup()

	// Validation guard fires synchronously before any Temporal-context
	// access, so context.Background is fine here.
	if err := ProvisionNamespaceActivity(context.Background(), ""); err == nil {
		t.Fatal("got nil error for empty tenantID, want validation error")
	}
}

// TestApplyAndWait_TimeoutOnNotReady asserts the timeout path fires
// when the fake never marks status.ready=true. Uses a short
// pollTimeout override to keep the test fast.
func TestApplyAndWait_TimeoutOnNotReady(t *testing.T) {
	_, cleanup := withFakeDynamicClient(t)
	defer cleanup()

	origTimeout := pollTimeout
	pollTimeout = 100 * time.Millisecond
	defer func() { pollTimeout = origTimeout }()

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(ProvisionNamespaceActivity)
	if _, err := env.ExecuteActivity(ProvisionNamespaceActivity, "stalled"); err == nil {
		t.Fatal("got nil error, want timeout")
	}
}
