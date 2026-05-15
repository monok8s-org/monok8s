package main

import (
	"context"
	"errors"
	"os"

	"go.temporal.io/sdk/activity"

	auth "github.com/monok8s/monok8s/packages/auth/go"
)

// AssignTenantRoleSpiceDBInput / UnassignTenantRoleSpiceDBInput —
// activity inputs for #232's TenantRoleAssign/UnassignWorkflows.
// Fields mirror the workflow inputs minus the audit-only fields
// (AssignedBy / UnassignedBy) which the activity doesn't need —
// SpiceDB write contract is principal + role + tenant only.
type AssignTenantRoleSpiceDBInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string // "user" | "service_account"
	Role        string
}

type UnassignTenantRoleSpiceDBInput struct {
	TenantID    string
	SubjectID   string
	SubjectType string
	Role        string
}

// tenantRoleWriter is the SpiceDB-write surface the activities depend
// on. Structurally satisfied by `*auth.Client`; tests inject a stub
// via setTenantRoleWriterForTesting. Interface-based DI keeps the
// activities pure-call-testable without spinning up a real SpiceDB.
type tenantRoleWriter interface {
	WriteTenantRoleAssigned(ctx context.Context, tenantID string, principal auth.Principal, role string) (string, error)
	WriteTenantRoleUnassigned(ctx context.Context, tenantID string, principal auth.Principal, role string) (string, error)
}

// Package-level singleton + test seam. nil in production until the
// first call constructs the real client (lazy init from SPICEDB_*
// env vars); tests bypass the lazy path by setting an explicit stub.
var tenantRoleWriterSingleton tenantRoleWriter

// setTenantRoleWriterForTesting — test seam. Test code calls this
// with a stub; teardown calls it with nil to reset.
func setTenantRoleWriterForTesting(w tenantRoleWriter) {
	tenantRoleWriterSingleton = w
}

// getTenantRoleWriter — returns the singleton, lazy-constructing from
// env vars on first production call. Mirrors the per-call dial in
// EmitTenantCreatedEventActivity but caches the client (SpiceDB
// connections are gRPC + reusable, vs NATS where per-call dial is
// fine because connections are cheap).
func getTenantRoleWriter() (tenantRoleWriter, error) {
	if tenantRoleWriterSingleton != nil {
		return tenantRoleWriterSingleton, nil
	}
	endpoint := os.Getenv("SPICEDB_ENDPOINT")
	if endpoint == "" {
		return nil, errors.New("SPICEDB_ENDPOINT env var not set")
	}
	token := os.Getenv("SPICEDB_TOKEN")
	if token == "" {
		return nil, errors.New("SPICEDB_TOKEN env var not set")
	}
	insecure := os.Getenv("SPICEDB_INSECURE") == "true"
	c, err := auth.NewClient(endpoint, token, insecure)
	if err != nil {
		return nil, err
	}
	tenantRoleWriterSingleton = c
	return c, nil
}

// AssignTenantRoleSpiceDBActivity writes the tenant→role→principal
// relation in SpiceDB. Idempotent: TOUCH operation re-writes are
// no-ops, so Temporal retries are safe.
func AssignTenantRoleSpiceDBActivity(ctx context.Context, input AssignTenantRoleSpiceDBInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("AssignTenantRoleSpiceDBActivity",
		"tenantID", input.TenantID,
		"subjectType", input.SubjectType,
		"subjectID", input.SubjectID,
		"role", input.Role,
	)
	w, err := getTenantRoleWriter()
	if err != nil {
		return err
	}
	_, err = w.WriteTenantRoleAssigned(ctx, input.TenantID,
		auth.Principal{Type: input.SubjectType, ID: input.SubjectID}, input.Role)
	return err
}

// UnassignTenantRoleSpiceDBActivity removes the tenant→role→principal
// relation. Idempotent: DELETE on a non-existent relation succeeds.
func UnassignTenantRoleSpiceDBActivity(ctx context.Context, input UnassignTenantRoleSpiceDBInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("UnassignTenantRoleSpiceDBActivity",
		"tenantID", input.TenantID,
		"subjectType", input.SubjectType,
		"subjectID", input.SubjectID,
		"role", input.Role,
	)
	w, err := getTenantRoleWriter()
	if err != nil {
		return err
	}
	_, err = w.WriteTenantRoleUnassigned(ctx, input.TenantID,
		auth.Principal{Type: input.SubjectType, ID: input.SubjectID}, input.Role)
	return err
}
