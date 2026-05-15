// Package auth provides typed SpiceDB relation writes for Temporal activities.
// Import this from worker activities — never call the SpiceDB gRPC client directly.
package auth

import (
	"context"
	"fmt"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/authzed/authzed-go/v1"
	"github.com/authzed/grpcutil"
)

type Client struct {
	spicedb *authzed.Client
}

func NewClient(endpoint, token string, insecure bool) (*Client, error) {
	var c *authzed.Client
	var err error
	if insecure {
		c, err = authzed.NewClient(endpoint,
			grpcutil.WithInsecureBearerToken(token))
	} else {
		c, err = authzed.NewClient(endpoint,
			grpcutil.WithBearerToken(token))
	}
	if err != nil {
		return nil, fmt.Errorf("spicedb client: %w", err)
	}
	return &Client{spicedb: c}, nil
}

// WriteUserRegistered writes the two bootstrap relations for a new user.
// Called once from the onboarding Temporal activity.
func (c *Client) WriteUserRegistered(ctx context.Context, userID string) (string, error) {
	return c.write(ctx,
		touch("user", userID, "self",     "user",     userID),
		touch("user", userID, "platform", "platform", "monok8s"),
	)
}

// WriteTenantCreated writes the platform back-reference and owner relation.
// Called once from the tenant provisioning Temporal activity.
func (c *Client) WriteTenantCreated(ctx context.Context, tenantID, ownerUserID string) (string, error) {
	return c.write(ctx,
		touch("tenant", tenantID, "platform", "platform", "monok8s"),
		touch("tenant", tenantID, "owner",    "user",     ownerUserID),
	)
}

// WriteSystemAdminRelation writes the only_system_can_create_tenants
// relation for the bootstrap admin user on system:monok8s. Called once
// from the install-time bootstrap Job (#98a) per Discussion #76 ("only
// the default admin tenant can create other tenants"). TOUCH semantics
// make this idempotent — re-running the bootstrap Job is safe.
func (c *Client) WriteSystemAdminRelation(ctx context.Context, userID string) (string, error) {
	return c.write(ctx,
		touch("system", "monok8s", "only_system_can_create_tenants", "user", userID),
	)
}

// WriteMemberJoined writes the role relation for a user joining a tenant.
// Called from the invitation acceptance Temporal activity.
func (c *Client) WriteMemberJoined(ctx context.Context, tenantID, userID, role string) (string, error) {
	return c.write(ctx,
		touch("tenant", tenantID, role, "user", userID),
	)
}

// WriteMemberRoleChanged swaps role relations atomically.
func (c *Client) WriteMemberRoleChanged(ctx context.Context, tenantID, userID, oldRole, newRole string) (string, error) {
	return c.write(ctx,
		del("tenant", tenantID, oldRole, "user", userID),
		touch("tenant", tenantID, newRole, "user", userID),
	)
}

// WriteMemberSuspended adds the suspended relation.
// Role relation is retained for reinstatement.
func (c *Client) WriteMemberSuspended(ctx context.Context, tenantID, userID string) (string, error) {
	return c.write(ctx,
		touch("tenant", tenantID, "suspended", "user", userID),
	)
}

// WriteMemberReinstated removes the suspended relation.
func (c *Client) WriteMemberReinstated(ctx context.Context, tenantID, userID string) (string, error) {
	return c.write(ctx,
		del("tenant", tenantID, "suspended", "user", userID),
	)
}

// WriteMemberRemoved removes the given role and any suspended relation for a user.
// role must be the user's current role. For multi-role users call once per role.
func (c *Client) WriteMemberRemoved(ctx context.Context, tenantID, userID, role string) (string, error) {
	return c.write(ctx,
		del("tenant", tenantID, role,        "user", userID),
		del("tenant", tenantID, "suspended", "user", userID),
	)
}

// Principal — subject type + id pair used by the principal-typed
// relation writes (#232). The Type field must be "user" or
// "service_account"; the schema doesn't permit other subject types
// on tenant role relations (per packages/auth/schema.zed).
type Principal struct {
	Type string // "user" | "service_account"
	ID   string
}

// WriteTenantRoleAssigned writes a tenant role relation for an
// arbitrary principal (user OR service_account). Companion to the
// user-only WriteMemberJoined — exists so the TenantRoleAssignWorkflow
// (#232) can grant roles to service accounts as well as users.
// Schema constraint: role cannot be "owner" for service_account
// principals; that's enforced at the API-side zod schema (Go workflow
// trusts its caller).
func (c *Client) WriteTenantRoleAssigned(ctx context.Context, tenantID string, principal Principal, role string) (string, error) {
	return c.write(ctx,
		touch("tenant", tenantID, role, principal.Type, principal.ID),
	)
}

// WriteTenantRoleUnassigned removes a tenant role relation for an
// arbitrary principal. Companion to WriteMemberRemoved — does NOT
// also delete the suspended relation (suspended is independent of
// role assignment; revoke vs role-removal are distinct ops).
func (c *Client) WriteTenantRoleUnassigned(ctx context.Context, tenantID string, principal Principal, role string) (string, error) {
	return c.write(ctx,
		del("tenant", tenantID, role, principal.Type, principal.ID),
	)
}

// WriteTenantRoleChanged atomically swaps a tenant role relation
// for an arbitrary principal — DELETE old + TOUCH new in one write
// (#236). Companion to user-only WriteMemberRoleChanged. The two
// updates are batched into a single SpiceDB call so there's no
// intermediate state where the principal has neither role.
//
// Caller must pre-check oldRole != newRole; this helper doesn't
// validate (the wire-side zod schema enforces).
func (c *Client) WriteTenantRoleChanged(ctx context.Context, tenantID string, principal Principal, oldRole, newRole string) (string, error) {
	return c.write(ctx,
		del("tenant", tenantID, oldRole, principal.Type, principal.ID),
		touch("tenant", tenantID, newRole, principal.Type, principal.ID),
	)
}

// WriteGroupMemberAdded adds a user as a member of a group (#248).
// User-only for v1; nested-group membership (`group#member@group:X#membership`)
// is a separate helper when needed. Mirrors the TS-side
// writeGroupMemberAdded in packages/auth/src/spicedb.ts.
func (c *Client) WriteGroupMemberAdded(ctx context.Context, groupID, userID string) (string, error) {
	return c.write(ctx,
		touch("group", groupID, "member", "user", userID),
	)
}

// WriteGroupMemberRemoved removes a user's group-member relation
// (#248). Idempotent at the SpiceDB layer: DELETE on a non-existent
// relation succeeds.
func (c *Client) WriteGroupMemberRemoved(ctx context.Context, groupID, userID string) (string, error) {
	return c.write(ctx,
		del("group", groupID, "member", "user", userID),
	)
}

// CanOnTenant checks a permission for a user on a tenant resource.
// Pass zedToken from a preceding write to prevent the new-enemy problem.
func (c *Client) CanOnTenant(ctx context.Context, userID, permission, tenantID, zedToken string) (bool, error) {
	return c.checkPermission(ctx, "tenant", tenantID, permission, "user", userID, zedToken)
}

// CanOnSystem checks a permission for a user on the singleton system resource.
// system:monok8s is the privileged-create scope; only members of
// only_system_can_create_tenants get create_tenants. Used by the L4
// install-time bootstrap e2e test (#145) to verify the bootstrap Job's
// SpiceDB relation write took effect. Pass zedToken from a preceding write.
func (c *Client) CanOnSystem(ctx context.Context, userID, permission, systemID, zedToken string) (bool, error) {
	return c.checkPermission(ctx, "system", systemID, permission, "user", userID, zedToken)
}

// CanSAOnTenant checks a permission for a service account on a tenant resource.
// Use this instead of CanOnTenant when the principal is a service account.
// Pass zedToken from a preceding write to prevent the new-enemy problem.
func (c *Client) CanSAOnTenant(ctx context.Context, saID, permission, tenantID, zedToken string) (bool, error) {
	return c.checkPermission(ctx, "tenant", tenantID, permission, "service_account", saID, zedToken)
}

// CanSubjectOnTenant dispatches to CanOnTenant or CanSAOnTenant based on subjectType.
// Use this in workers that receive subject type as data (IAM writeback, access review).
// For API procedures where the principal type is known at compile time, call the
// typed variants directly.
func (c *Client) CanSubjectOnTenant(ctx context.Context, subjectID, subjectType, permission, tenantID, zedToken string) (bool, error) {
	switch subjectType {
	case "user":
		return c.CanOnTenant(ctx, subjectID, permission, tenantID, zedToken)
	case "service_account":
		return c.CanSAOnTenant(ctx, subjectID, permission, tenantID, zedToken)
	default:
		return false, fmt.Errorf("unknown subject type: %q", subjectType)
	}
}

func (c *Client) checkPermission(ctx context.Context, resourceType, resourceID, permission, subjectType, subjectID, zedToken string) (bool, error) {
	req := &v1.CheckPermissionRequest{
		Resource:   obj(resourceType, resourceID),
		Permission: permission,
		Subject:    subj(subjectType, subjectID),
	}
	if zedToken != "" {
		req.Consistency = atLeastAsFresh(zedToken)
	} else {
		req.Consistency = minimizeLatency()
	}
	res, err := c.spicedb.CheckPermission(ctx, req)
	if err != nil {
		return false, fmt.Errorf("spicedb check: %w", err)
	}
	return res.Permissionship == v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION, nil
}

// ── helpers ───────────────────────────────────────────────────────────────────

func (c *Client) write(ctx context.Context, updates ...*v1.RelationshipUpdate) (string, error) {
	res, err := c.spicedb.WriteRelationships(ctx, &v1.WriteRelationshipsRequest{
		Updates: updates,
	})
	if err != nil {
		return "", fmt.Errorf("spicedb write: %w", err)
	}
	return res.WrittenAt.Token, nil
}

func touch(rt, ri, rel, st, si string) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{
		Operation:    v1.RelationshipUpdate_OPERATION_TOUCH,
		Relationship: relationship(rt, ri, rel, st, si),
	}
}

func del(rt, ri, rel, st, si string) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{
		Operation:    v1.RelationshipUpdate_OPERATION_DELETE,
		Relationship: relationship(rt, ri, rel, st, si),
	}
}

func relationship(rt, ri, rel, st, si string) *v1.Relationship {
	return &v1.Relationship{
		Resource: obj(rt, ri),
		Relation: rel,
		Subject:  subj(st, si),
	}
}

func obj(t, id string) *v1.ObjectReference {
	return &v1.ObjectReference{ObjectType: t, ObjectId: id}
}

func subj(t, id string) *v1.SubjectReference {
	return &v1.SubjectReference{Object: obj(t, id)}
}

func atLeastAsFresh(token string) *v1.Consistency {
	return &v1.Consistency{
		Requirement: &v1.Consistency_AtLeastAsFresh{
			AtLeastAsFresh: &v1.ZedToken{Token: token},
		},
	}
}

func minimizeLatency() *v1.Consistency {
	return &v1.Consistency{
		Requirement: &v1.Consistency_MinimizeLatency{MinimizeLatency: true},
	}
}
