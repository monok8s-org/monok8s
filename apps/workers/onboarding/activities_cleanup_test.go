package main

import (
	"context"
	"encoding/json"
	"strings"
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

// startInProcessNATSForCleanup mirrors the helper from
// activities_emit_test.go / activities_argo_test.go. Separate function
// to keep test files independent.
func startInProcessNATSForCleanup(t *testing.T) (string, func()) {
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

// withFakeDynamicClientForCleanup installs a dynamic/fake-backed
// factory with both XR list kinds registered. Optionally pre-creates
// XR objects so DELETE has something to act on.
func withFakeDynamicClientForCleanup(t *testing.T, prepopulate ...runtime.Object) (*dynamicfake.FakeDynamicClient, func()) {
	t.Helper()
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "monok8s.io", Version: "v1alpha1", Kind: "XTenantList"},
		&unstructured.UnstructuredList{},
	)
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "monok8s.io", Version: "v1alpha1", Kind: "XTenantDatabaseList"},
		&unstructured.UnstructuredList{},
	)
	fake := dynamicfake.NewSimpleDynamicClient(scheme, prepopulate...)

	origFactory := dynamicClientFactory
	dynamicClientFactory = func() (dynamic.Interface, error) { return fake, nil }

	return fake, func() { dynamicClientFactory = origFactory }
}

// newXR is a helper to construct an unstructured XR with the given
// GVK + name for prepopulation.
func newXR(group, version, kind, name string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": group + "/" + version,
		"kind":       kind,
		"metadata":   map[string]any{"name": name},
	}}
}

// ── DeleteTenantNamespaceActivity ────────────────────────────────────────

func TestDeleteTenantNamespaceActivity_Succeeds(t *testing.T) {
	xr := newXR("monok8s.io", "v1alpha1", "XTenant", "acme")
	fake, cleanup := withFakeDynamicClientForCleanup(t, xr)
	defer cleanup()

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTenantNamespaceActivity)
	if _, err := env.ExecuteActivity(DeleteTenantNamespaceActivity, "acme"); err != nil {
		t.Fatalf("DeleteTenantNamespaceActivity: %v", err)
	}

	if _, err := fake.Resource(xtenantGVR).Get(context.Background(), "acme", metav1.GetOptions{}); err == nil {
		t.Errorf("XTenant XR still present after delete")
	}
}

func TestDeleteTenantNamespaceActivity_AlreadyGone(t *testing.T) {
	_, cleanup := withFakeDynamicClientForCleanup(t) // empty fake
	defer cleanup()

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTenantNamespaceActivity)
	if _, err := env.ExecuteActivity(DeleteTenantNamespaceActivity, "ghost"); err != nil {
		t.Fatalf("expected nil for already-gone XR, got %v", err)
	}
}

func TestDeleteTenantNamespaceActivity_EmptyTenantID(t *testing.T) {
	if err := DeleteTenantNamespaceActivity(context.Background(), ""); err == nil {
		t.Fatal("got nil for empty tenantID, want validation error")
	}
}

// ── DeleteTenantDatabaseActivity ─────────────────────────────────────────

func TestDeleteTenantDatabaseActivity_Succeeds(t *testing.T) {
	xr := newXR("monok8s.io", "v1alpha1", "XTenantDatabase", "acme-app")
	fake, cleanup := withFakeDynamicClientForCleanup(t, xr)
	defer cleanup()

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTenantDatabaseActivity)
	if _, err := env.ExecuteActivity(DeleteTenantDatabaseActivity, "acme"); err != nil {
		t.Fatalf("DeleteTenantDatabaseActivity: %v", err)
	}

	if _, err := fake.Resource(xtenantdatabaseGVR).Get(context.Background(), "acme-app", metav1.GetOptions{}); err == nil {
		t.Errorf("XTenantDatabase XR still present after delete")
	}
}

func TestDeleteTenantDatabaseActivity_AlreadyGone(t *testing.T) {
	_, cleanup := withFakeDynamicClientForCleanup(t)
	defer cleanup()

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(DeleteTenantDatabaseActivity)
	if _, err := env.ExecuteActivity(DeleteTenantDatabaseActivity, "ghost"); err != nil {
		t.Fatalf("expected nil for already-gone XR, got %v", err)
	}
}

func TestDeleteTenantDatabaseActivity_EmptyTenantID(t *testing.T) {
	if err := DeleteTenantDatabaseActivity(context.Background(), ""); err == nil {
		t.Fatal("got nil for empty tenantID, want validation error")
	}
}

// ── DeleteTenantVaultKeyActivity (stub) ──────────────────────────────────

func TestDeleteTenantVaultKeyActivity_ReturnsStubError(t *testing.T) {
	err := DeleteTenantVaultKeyActivity(context.Background(), "acme")
	if err == nil {
		t.Fatal("got nil, want stub error")
	}
	if !strings.Contains(err.Error(), "WorkflowTemplate") {
		t.Errorf("error message missing WorkflowTemplate context: %q", err.Error())
	}
}

// ── EmitTenantCreationFailedEventActivity ────────────────────────────────

func TestEmitTenantCreationFailedEventActivity_Publishes(t *testing.T) {
	url, shutdown := startInProcessNATSForCleanup(t)
	defer shutdown()

	sub, err := nats.Connect(url, nats.Timeout(2*time.Second))
	if err != nil {
		t.Fatalf("subscriber nats.Connect: %v", err)
	}
	defer sub.Close()
	msgCh := make(chan *nats.Msg, 1)
	if _, err := sub.Subscribe("tenant.acme.events", func(m *nats.Msg) {
		msgCh <- m
	}); err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if err := sub.Flush(); err != nil {
		t.Fatalf("subscriber flush: %v", err)
	}

	t.Setenv("NATS_URL", url)

	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(EmitTenantCreationFailedEventActivity)
	if _, err := env.ExecuteActivity(EmitTenantCreationFailedEventActivity, "acme"); err != nil {
		t.Fatalf("ExecuteActivity: %v", err)
	}

	select {
	case msg := <-msgCh:
		var evt tenantEvent
		if err := json.Unmarshal(msg.Data, &evt); err != nil {
			t.Fatalf("unmarshal event: %v", err)
		}
		if evt.TenantID != "acme" {
			t.Errorf("tenantId: got %q, want %q", evt.TenantID, "acme")
		}
		if evt.Event != "tenant.creation-failed" {
			t.Errorf("event: got %q, want %q", evt.Event, "tenant.creation-failed")
		}
		if _, parseErr := time.Parse(time.RFC3339Nano, evt.Timestamp); parseErr != nil {
			t.Errorf("timestamp not RFC3339Nano: %q (%v)", evt.Timestamp, parseErr)
		}
		if msg.Subject != "tenant.acme.events" {
			t.Errorf("subject: got %q, want %q", msg.Subject, "tenant.acme.events")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for published event")
	}
}

func TestEmitTenantCreationFailedEventActivity_EmptyTenantID(t *testing.T) {
	if err := EmitTenantCreationFailedEventActivity(context.Background(), ""); err == nil {
		t.Fatal("got nil for empty tenantID, want validation error")
	}
}
