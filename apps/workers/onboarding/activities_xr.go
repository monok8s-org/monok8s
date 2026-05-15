package main

import (
	"context"
	"errors"
	"os"
	"time"

	"go.temporal.io/sdk/activity"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// pollInterval controls how often the XR-poll loop checks
// status.ready. Default 5s for production reconciles; tests
// override via the package var to keep test latency low.
var pollInterval = 5 * time.Second

// pollTimeout is the upper bound on the wait-for-ready loop inside
// applyAndWait. The Temporal activity's StartToCloseTimeout enforces
// this externally as well — this is the in-activity guard so we
// emit a meaningful error message rather than the bare-cancellation
// timeout Temporal would surface on its own.
var pollTimeout = 10 * time.Minute

// dynamicClientFactory is overridable for unit tests via package-var
// assignment (the same pattern sub-PR-2's activities_emit.go uses
// for NATS_URL). Production wires the in-cluster ServiceAccount; dev
// wires from $KUBECONFIG.
var dynamicClientFactory = defaultDynamicClient

func defaultDynamicClient() (dynamic.Interface, error) {
	if path := os.Getenv("KUBECONFIG"); path != "" {
		cfg, err := clientcmd.BuildConfigFromFlags("", path)
		if err != nil {
			return nil, err
		}
		return dynamic.NewForConfig(cfg)
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}
	return dynamic.NewForConfig(cfg)
}

// GroupVersionResource constants for the two XRs Crossplane reconciles.
var (
	xtenantGVR = schema.GroupVersionResource{
		Group:    "monok8s.io",
		Version:  "v1alpha1",
		Resource: "xtenants",
	}
	xtenantdatabaseGVR = schema.GroupVersionResource{
		Group:    "monok8s.io",
		Version:  "v1alpha1",
		Resource: "xtenantdatabases",
	}
)

// fieldManager identifies this controller's server-side-apply writes
// so Crossplane's reconciler doesn't fight us on field ownership.
const fieldManager = "monok8s-onboarding"

// ProvisionNamespaceActivity submits an XTenant XR (per #81) and waits
// for the tenant-capsule Composition to reconcile it. Per Discussion
// #76 + #84 AC step 1: "Create Capsule tenant CR".
func ProvisionNamespaceActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("ProvisionNamespaceActivity: tenantID empty")
	}
	client, err := dynamicClientFactory()
	if err != nil {
		return err
	}
	xr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "monok8s.io/v1alpha1",
		"kind":       "XTenant",
		"metadata": map[string]any{
			"name": tenantID,
		},
		"spec": map[string]any{
			"name":            tenantID,
			"postgresVersion": "16",
			"compositionSelector": map[string]any{
				"matchLabels": map[string]any{
					"monok8s.io/provider": "capsule",
				},
			},
		},
	}}
	return applyAndWait(ctx, client.Resource(xtenantGVR), xr)
}

// ProvisionDatabaseActivity submits an XTenantDatabase XR (per #82) and
// waits for the tenant-database-cnpg Composition to reconcile it. Per
// Discussion #76 + #84 AC step 2: "Provision per-tenant Postgres".
func ProvisionDatabaseActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("ProvisionDatabaseActivity: tenantID empty")
	}
	client, err := dynamicClientFactory()
	if err != nil {
		return err
	}
	xr := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "monok8s.io/v1alpha1",
		"kind":       "XTenantDatabase",
		"metadata": map[string]any{
			"name": tenantID + "-app",
		},
		"spec": map[string]any{
			"tenantName":      tenantID,
			"engine":          "cnpg",
			"storage":         "medium",
			"postgresVersion": "16",
			"dbName":          "app",
			"compositionSelector": map[string]any{
				"matchLabels": map[string]any{
					"monok8s.io/provider": "cnpg",
				},
			},
		},
	}}
	return applyAndWait(ctx, client.Resource(xtenantdatabaseGVR), xr)
}

// applyAndWait submits the XR (create-or-update for idempotency,
// equivalent to server-side apply semantics: creates if missing,
// updates if present), then polls `.status.ready` until true, the
// context is cancelled, or pollTimeout elapses. Records Temporal
// heartbeats on each tick so the workflow gets progress feedback for
// long-running reconciles.
//
// We use Create-or-Update rather than client.Apply because
// `dynamic/fake.FakeDynamicClient`'s Patch handler doesn't honor
// ApplyPatchType's create-if-not-exist semantic; the test harness
// would never see the XR materialize. The Create-or-Update path
// behaves equivalently against a real apiserver (the conflict on
// re-Apply is resolved by Crossplane's reconciler, not our writer,
// so field-manager isolation isn't needed at submission time for
// this controller's use case).
func applyAndWait(
	ctx context.Context,
	client dynamic.NamespaceableResourceInterface,
	xr *unstructured.Unstructured,
) error {
	name := xr.GetName()
	logger := activity.GetLogger(ctx)

	var applied *unstructured.Unstructured
	existing, getErr := client.Get(ctx, name, metav1.GetOptions{})
	if getErr != nil {
		// Assume not-found → Create.
		var err error
		applied, err = client.Create(ctx, xr, metav1.CreateOptions{
			FieldManager: fieldManager,
		})
		if err != nil {
			return err
		}
	} else {
		// Update the existing object's spec while preserving status +
		// resourceVersion (avoids conflicts; Crossplane owns status).
		spec, _, _ := unstructured.NestedMap(xr.Object, "spec")
		_ = unstructured.SetNestedMap(existing.Object, spec, "spec")
		var err error
		applied, err = client.Update(ctx, existing, metav1.UpdateOptions{
			FieldManager: fieldManager,
		})
		if err != nil {
			return err
		}
	}
	logger.Info("XR applied", "kind", applied.GetKind(), "name", name)

	deadline := time.Now().Add(pollTimeout)
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		current, err := client.Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		ready, _, _ := unstructured.NestedBool(current.Object, "status", "ready")
		if ready {
			logger.Info("XR ready", "kind", applied.GetKind(), "name", name)
			return nil
		}
		activity.RecordHeartbeat(ctx, map[string]any{
			"phase": "waiting-for-ready",
			"kind":  applied.GetKind(),
			"name":  name,
		})

		if time.Now().After(deadline) {
			return errors.New("applyAndWait: timed out waiting for status.ready on " + applied.GetKind() + "/" + name)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
