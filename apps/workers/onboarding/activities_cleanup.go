package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"time"

	"github.com/nats-io/nats.go"
	"go.temporal.io/sdk/activity"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Compensation activities for OnboardTenantWorkflow per #129a. The
// workflow invokes these in reverse order from a cleanup closure when
// any forward activity fails after step 1. Each is idempotent — 404
// from the apiserver returns nil so re-invocation against an
// already-cleaned resource succeeds — because Temporal's default
// retry policy may invoke a cleanup activity multiple times during
// teardown.
//
// Coverage:
//
//   ProvisionNamespaceActivity         ↔  DeleteTenantNamespaceActivity
//   ProvisionDatabaseActivity          ↔  DeleteTenantDatabaseActivity
//   MintTenantVaultKeyActivity         ↔  DeleteTenantVaultKeyActivity (stub)
//   RunMigrationsActivity              ↔  (none — Atlas no-rollback, Gap-logged)
//   EmitTenantCreatedEventActivity     ↔  EmitTenantCreationFailedEventActivity

// DeleteTenantNamespaceActivity DELETEs the XTenant XR; Crossplane's
// reconciler cascades to the per-tenant namespace + Capsule Tenant CR.
// 404 from the apiserver is treated as success — the resource is
// already gone, which is the post-condition this activity targets.
func DeleteTenantNamespaceActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("DeleteTenantNamespaceActivity: tenantID empty")
	}
	client, err := dynamicClientFactory()
	if err != nil {
		return err
	}
	logger := activity.GetLogger(ctx)
	err = client.Resource(xtenantGVR).Delete(ctx, tenantID, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	logger.Info("XTenant XR deleted", "tenantID", tenantID)
	return nil
}

// DeleteTenantDatabaseActivity DELETEs the XTenantDatabase XR;
// Crossplane cascades to the CNPG Cluster + PVC. The XR name follows
// ProvisionDatabaseActivity's convention: `<tenantID>-app`. 404 is
// success.
func DeleteTenantDatabaseActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("DeleteTenantDatabaseActivity: tenantID empty")
	}
	client, err := dynamicClientFactory()
	if err != nil {
		return err
	}
	name := tenantID + "-app"
	logger := activity.GetLogger(ctx)
	err = client.Resource(xtenantdatabaseGVR).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	logger.Info("XTenantDatabase XR deleted", "tenantID", tenantID, "name", name)
	return nil
}

// DeleteTenantVaultKeyActivity is a stub. Production cleanup of a
// per-tenant Vault transit key requires a future
// `delete-tenant-vault-key` Argo WorkflowTemplate that runs
// `vault delete transit/keys/tenant-<tid>` (Vault transit keys can't
// be deleted by default — deletion_allowed must first be set via
// `vault write transit/keys/tenant-<tid>/config deletion_allowed=true`).
// Tracked as a follow-up Issue; the workflow's cleanup loop ignores
// errors from cleanup activities so the stub is safe to register.
func DeleteTenantVaultKeyActivity(_ context.Context, _ string) error {
	return errors.New("DeleteTenantVaultKeyActivity: pending delete-tenant-vault-key WorkflowTemplate (Gap-logged in Discussion #45)")
}

// EmitTenantCreationFailedEventActivity publishes `tenant.creation-failed`
// to NATS subject `tenant.<tid>.events`. Mirrors
// EmitTenantCreatedEventActivity's connect→publish→flush→close
// lifecycle; same NATS_URL env-var resolution + tenantEvent JSON
// envelope shape.
func EmitTenantCreationFailedEventActivity(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return errors.New("EmitTenantCreationFailedEventActivity: tenantID empty")
	}

	url := os.Getenv("NATS_URL")
	if url == "" {
		url = DefaultNATSURL
	}

	logger := activity.GetLogger(ctx)
	logger.Info("EmitTenantCreationFailedEventActivity: dialing NATS",
		"url", url, "tenantID", tenantID)

	nc, err := nats.Connect(url, nats.Timeout(5*time.Second))
	if err != nil {
		return err
	}
	defer nc.Close()

	body, err := json.Marshal(tenantEvent{
		TenantID:  tenantID,
		Event:     "tenant.creation-failed",
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		return err
	}

	subject := "tenant." + tenantID + ".events"
	if err := nc.Publish(subject, body); err != nil {
		return err
	}
	if err := nc.Flush(); err != nil {
		return err
	}
	return nc.LastError()
}
