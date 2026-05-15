// Package spicedb declares the SpiceDB helper surface consumed by the
// Go workers (apps/workers/iam-writeback etc.). Stub-only — the real
// implementations land with #33 (packages/auth Zitadel/SpiceDB helpers).
// This file exists today so that the Go module structure resolves under
// `go mod tidy` per #107; the consumers' BUILD wiring follows when their
// respective sub-issues land.
package spicedb

import (
	"context"
	"errors"
)

const errStub = "NotImplemented: packages/auth/go/spicedb — real helpers land in #33"

func CanOnTenant(ctx context.Context, subjectID, perm, tenantID, zedToken string, caveatCtx map[string]any) (bool, error) {
	return false, errors.New(errStub + ": CanOnTenant")
}

func CanSAOnTenant(ctx context.Context, saID, perm, tenantID, zedToken string, caveatCtx map[string]any) (bool, error) {
	return false, errors.New(errStub + ": CanSAOnTenant")
}

func WriteMemberJoined(ctx context.Context, tenantID, userID, role string) (string, error) {
	return "", errors.New(errStub + ": WriteMemberJoined")
}

func WriteMemberRemoved(ctx context.Context, tenantID, userID, role string) (string, error) {
	return "", errors.New(errStub + ": WriteMemberRemoved")
}

func WriteServiceAccountRemoved(ctx context.Context, tenantID, saID, role string) (string, error) {
	return "", errors.New(errStub + ": WriteServiceAccountRemoved")
}

func WriteServiceAccountRoleChanged(ctx context.Context, tenantID, saID, oldRole, newRole string) (string, error) {
	return "", errors.New(errStub + ": WriteServiceAccountRoleChanged")
}
