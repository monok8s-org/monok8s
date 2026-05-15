package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/mocks"
	"github.com/stretchr/testify/mock"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes"
	k8sfake "k8s.io/client-go/kubernetes/fake"
)

// installFactories swaps in mocked variants for the duration of the
// test and returns a cleanup func that restores defaults.
func installFactories(t *testing.T, opts factoryOpts) func() {
	t.Helper()
	origK8s := k8sClientFactory
	origDyn := dynamicClientFactory
	origTemporal := temporalClientFactory
	origZitadel := zitadelClientFactory
	origSpiceDB := spicedbWriter

	k8sClientFactory = func() (kubernetes.Interface, error) {
		if opts.k8sErr != nil {
			return nil, opts.k8sErr
		}
		return opts.k8s, nil
	}
	dynamicClientFactory = func() (dynamic.Interface, error) {
		if opts.dynErr != nil {
			return nil, opts.dynErr
		}
		return opts.dyn, nil
	}
	temporalClientFactory = func() (client.Client, error) {
		if opts.temporalErr != nil {
			return nil, opts.temporalErr
		}
		return opts.temporal, nil
	}
	zitadelClientFactory = func() (*zitadelClient, error) {
		if opts.zitadelErr != nil {
			return nil, opts.zitadelErr
		}
		return opts.zitadel, nil
	}
	spicedbWriter = func(_ context.Context, _ string) error {
		return opts.spicedbErr
	}

	return func() {
		k8sClientFactory = origK8s
		dynamicClientFactory = origDyn
		temporalClientFactory = origTemporal
		zitadelClientFactory = origZitadel
		spicedbWriter = origSpiceDB
	}
}

type factoryOpts struct {
	k8s         kubernetes.Interface
	k8sErr      error
	dyn         dynamic.Interface
	dynErr      error
	temporal    client.Client
	temporalErr error
	zitadel     *zitadelClient
	zitadelErr  error
	spicedbErr  error
}

// secretWithKeys returns a fake k8s client preloaded with the
// monok8s-bootstrap-admin Secret in the install namespace.
func secretWithKeys(email, password string) kubernetes.Interface {
	return k8sfake.NewSimpleClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      bootstrapAdminSecretName,
			Namespace: installNamespace,
		},
		Data: map[string][]byte{
			"email":           []byte(email),
			"initialPassword": []byte(password),
		},
	})
}

// emptyDynClient returns a fake dynamic client with the XTenant list
// kind registered but no objects pre-created.
func emptyDynClient() *dynamicfake.FakeDynamicClient {
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "monok8s.io", Version: "v1alpha1", Kind: "XTenantList"},
		&unstructured.UnstructuredList{},
	)
	return dynamicfake.NewSimpleDynamicClient(scheme)
}

// dynClientWithSystemTenant adds a pre-existing system XTenant XR.
func dynClientWithSystemTenant() *dynamicfake.FakeDynamicClient {
	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(
		schema.GroupVersionKind{Group: "monok8s.io", Version: "v1alpha1", Kind: "XTenantList"},
		&unstructured.UnstructuredList{},
	)
	xr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "monok8s.io/v1alpha1",
		"kind":       "XTenant",
		"metadata":   map[string]any{"name": systemTenantID},
	}}
	return dynamicfake.NewSimpleDynamicClient(scheme, xr)
}

// zitadelClientWithFake stands up an httptest server emulating the
// Zitadel v2 user API. If existingEmail is non-empty, /v2/users
// search responses include a record with existingUserID; otherwise
// search returns empty + /v2/users/human creates with newUserID.
func zitadelClientWithFake(t *testing.T, existingEmail, existingUserID, newUserID string) (*zitadelClient, func()) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v2/users" && r.Method == "POST":
			body, _ := readReqBody(r)
			if existingEmail != "" && strings.Contains(string(body), existingEmail) {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"result": []map[string]string{{"id": existingUserID}},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"result": []any{}})
		case r.URL.Path == "/v2/users/human" && r.Method == "POST":
			_ = json.NewEncoder(w).Encode(map[string]string{"userId": newUserID})
		default:
			http.NotFound(w, r)
		}
	}))
	return &zitadelClient{
		baseURL: srv.URL,
		pat:     "test-pat",
		http:    &http.Client{},
	}, srv.Close
}

func readReqBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	buf := make([]byte, 16384)
	n, _ := r.Body.Read(buf)
	return buf[:n], nil
}

// successfulWorkflowRun returns a mocks.WorkflowRun that reports a
// successful Get() (nil error).
func successfulWorkflowRun() *mocks.WorkflowRun {
	wr := &mocks.WorkflowRun{}
	wr.On("GetID").Return("test-wf-id")
	wr.On("GetRunID").Return("test-run-id")
	wr.On("Get", mock.Anything, mock.Anything).Return(nil)
	return wr
}

// ── Test cases ─────────────────────────────────────────────────────

func TestRun_FirstInstall_Succeeds(t *testing.T) {
	zclient, shutdown := zitadelClientWithFake(t, "", "", "user-new-12345")
	defer shutdown()

	mc := &mocks.Client{}
	mc.On("ExecuteWorkflow", mock.Anything, mock.Anything, "OnboardTenantWorkflow", mock.Anything).Return(
		successfulWorkflowRun(), nil,
	)
	mc.On("Close").Return()

	cleanup := installFactories(t, factoryOpts{
		k8s:      secretWithKeys("admin@example.com", "initial-password"),
		dyn:      emptyDynClient(),
		temporal: mc,
		zitadel:  zclient,
	})
	defer cleanup()

	if err := run(); err != nil {
		t.Fatalf("run: %v", err)
	}
}

func TestRun_SystemTenantAlreadyExists_SkipsIdempotently(t *testing.T) {
	zclient, shutdown := zitadelClientWithFake(t, "admin@example.com", "user-existing", "user-new")
	defer shutdown()

	// Temporal client should NEVER be called when the XR already exists.
	// We do NOT register an ExecuteWorkflow mock — if it's called,
	// testify's strict-mock mode will fail the test.
	mc := &mocks.Client{}

	cleanup := installFactories(t, factoryOpts{
		k8s:      secretWithKeys("admin@example.com", "initial-password"),
		dyn:      dynClientWithSystemTenant(),
		temporal: mc,
		zitadel:  zclient,
	})
	defer cleanup()

	if err := run(); err != nil {
		t.Fatalf("run on re-execute: %v", err)
	}

	mc.AssertNotCalled(t, "ExecuteWorkflow")
}

func TestRun_SecretMissing_ReturnsError(t *testing.T) {
	cleanup := installFactories(t, factoryOpts{
		k8s: k8sfake.NewSimpleClientset(), // no Secret at all
		dyn: emptyDynClient(),
	})
	defer cleanup()

	err := run()
	if err == nil {
		t.Fatal("got nil error, want secret-not-found")
	}
	if !strings.Contains(err.Error(), bootstrapAdminSecretName) {
		t.Errorf("error message missing secret name: %q", err.Error())
	}
}

func TestRun_SecretMissingEmailKey_ReturnsValidationError(t *testing.T) {
	k8sCli := k8sfake.NewSimpleClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      bootstrapAdminSecretName,
			Namespace: installNamespace,
		},
		Data: map[string][]byte{
			"initialPassword": []byte("pw-only"),
		},
	})

	cleanup := installFactories(t, factoryOpts{k8s: k8sCli, dyn: emptyDynClient()})
	defer cleanup()

	err := run()
	if err == nil {
		t.Fatal("got nil error, want validation error for missing email")
	}
	if !strings.Contains(err.Error(), "email") {
		t.Errorf("error message missing 'email': %q", err.Error())
	}
}

func TestRun_SpiceDBWriteFails_PropagatesError(t *testing.T) {
	zclient, shutdown := zitadelClientWithFake(t, "", "", "user-12345")
	defer shutdown()

	mc := &mocks.Client{}
	mc.On("ExecuteWorkflow", mock.Anything, mock.Anything, "OnboardTenantWorkflow", mock.Anything).Return(
		successfulWorkflowRun(), nil,
	)
	mc.On("Close").Return()

	cleanup := installFactories(t, factoryOpts{
		k8s:        secretWithKeys("admin@example.com", "initial-password"),
		dyn:        emptyDynClient(),
		temporal:   mc,
		zitadel:    zclient,
		spicedbErr: errors.New("spicedb network error"),
	})
	defer cleanup()

	err := run()
	if err == nil {
		t.Fatal("got nil error, want spicedb propagation")
	}
	if !strings.Contains(err.Error(), "spicedb") {
		t.Errorf("error message missing spicedb context: %q", err.Error())
	}
}
