// Handler functions for principal-read tRPC procedures (#197 — Rule 11
// no_buried_chains). Each function is plain-call-testable in isolation
// without going through the tRPC procedure builder; principals.ts wires
// them as thin inline lambdas via tenantProcedure("read").
//
// Two shapes:
//   - DB-only handlers take `(db, ...)` and call packages/db helpers
//   - SpiceDB handlers take `(tenantId, ...)` and call packages/auth
//
// Mutations (#234 roles.assign / roles.unassign etc.) follow the
// workflow-start pattern from grants.create_temporary: handler takes
// a DI bag (temporal, newId?) and dispatches via ctx.temporal.start(...).

import { randomUUID } from "node:crypto";

import type { WorkflowClient } from "@temporalio/client";

import { TRPCError } from "@trpc/server";

import {
  checkRelation,
  isPlatformAdmin,
  lookupSubjects,
  type SubjectRef,
} from "@monok8s/auth";
import {
  groups as groupsDb,
  tenants as tenantsDb,
  users as usersDb,
  type Group,
  type Pool,
} from "@monok8s/db";

// Tenant roles per packages/auth/schema.zed. The order here is the
// stable iteration order for `roles.list_for_principal` so the
// response is deterministic across runs.
export const TENANT_ROLES = [
  "owner",
  "admin",
  "member",
  "viewer",
  "billing_manager",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

// ── tenants ──────────────────────────────────────────────────────────────────

export const listTenants = (db: Pool) => tenantsDb.list(db);

export const getTenant = (db: Pool, id: string) => tenantsDb.findById(db, id);

// ── users ────────────────────────────────────────────────────────────────────

export const listUsersInTenant = (db: Pool, tenantId: string) =>
  usersDb.findByTenant(db, tenantId);

export const getUser = (db: Pool, id: string) => usersDb.findById(db, id);

// ── groups ───────────────────────────────────────────────────────────────────

export const listGroupsInTenant = (db: Pool, tenantId: string) =>
  groupsDb.list(db, tenantId);

export const getGroup = (db: Pool, id: string) => groupsDb.findById(db, id);

// createGroup — first principal mutation (#217 / #87 mutation tail).
// tenantId comes from the verified JWT (ctx.user.tenantId), NEVER
// from the wire input — same posture as the reads. The DB helper
// signature uses snake_case (pg column names) so we translate here.
export const createGroup = (
  db: Pool,
  tenantId: string,
  input: { name: string; parentGroupId?: string | null },
) =>
  groupsDb.create(db, {
    tenant_id: tenantId,
    name: input.name,
    parent_group_id: input.parentGroupId ?? null,
  });

// updateGroup — PATCH-style mutation (#220 / #87 mutation tail).
// Two-step: read-then-write so we can verify the group belongs to
// the caller's tenant before mutating. RLS would also block the
// UPDATE for cross-tenant rows, but explicit tenant check gives a
// clearer 404-shaped null vs. an opaque 0-row-affected outcome.
//
// Returns the updated Group on success, null when the group either
// doesn't exist or belongs to a different tenant.
export const updateGroup = async (
  db: Pool,
  tenantId: string,
  id: string,
  input: { name?: string; parentGroupId?: string | null },
): Promise<Group | null> => {
  const existing = await groupsDb.findById(db, id);
  if (existing === null || existing.tenant_id !== tenantId) return null;
  return groupsDb.update(db, id, {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.parentGroupId !== undefined && {
      parent_group_id: input.parentGroupId,
    }),
  });
};

// deleteGroup — same tenant-scoping check pattern as updateGroup.
// Returns { id } on success, null when missing or cross-tenant.
export const deleteGroup = async (
  db: Pool,
  tenantId: string,
  id: string,
): Promise<{ id: string } | null> => {
  const existing = await groupsDb.findById(db, id);
  if (existing === null || existing.tenant_id !== tenantId) return null;
  return groupsDb.delete(db, id);
};

// ── roles ────────────────────────────────────────────────────────────────────

export async function listRolesForPrincipal(
  tenantId: string,
  principal: SubjectRef,
): Promise<{ roles: TenantRole[] }> {
  const checks = TENANT_ROLES.map(async (role) => {
    const allowed = await checkRelation(
      { type: "tenant", id: tenantId },
      role,
      principal,
    );
    return allowed ? role : null;
  });
  const results = await Promise.all(checks);
  return {
    roles: results.filter((r): r is TenantRole => r !== null),
  };
}

export async function expandPrincipalsForRole(
  tenantId: string,
  role: TenantRole,
) {
  // Return type inferred from lookupSubjects' shape — leaving it as
  // inferred so the handler's wire surface tracks the SpiceDB helper
  // automatically if its return type ever widens.
  const [users, serviceAccounts] = await Promise.all([
    lookupSubjects({ type: "tenant", id: tenantId }, role, "user"),
    lookupSubjects({ type: "tenant", id: tenantId }, role, "service_account"),
  ]);
  return { users, serviceAccounts };
}

// ── role-assign mutations (#234 — PR-2 of roles.assign chain) ────────────────
//
// Workflow-start mutations that consume the TenantRoleAssign/Unassign
// Workflows from #232 (PR #233). Same DI-bag pattern as the
// grants.create_temporary handler — temporal client + newId override
// keep the handlers plain-call-testable.
//
// Workflow ID convention per #177 tnt-prefix: each assign/unassign
// gets a fresh UUID anchor so concurrent requests for the same
// (principal, role) generate distinct workflow executions (audit-
// trail integrity).

export interface RoleAssignmentInput {
  principal: { id: string; type: "user" | "service_account" };
  role: TenantRole;
}

export interface RoleAssignmentResult {
  workflowId: string;
}

export interface RoleAssignmentDeps {
  temporal: WorkflowClient;
  newId?: () => string;
}

export async function assignTenantRole(
  deps: RoleAssignmentDeps,
  tenantId: string,
  _assignedByUserId: string,
  input: RoleAssignmentInput,
): Promise<RoleAssignmentResult> {
  const assignmentId = (deps.newId ?? randomUUID)();
  const workflowId = `tnt-${tenantId}-role-assign-${assignmentId}`;
  await deps.temporal.start("TenantRoleAssignWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        SubjectID: input.principal.id,
        SubjectType: input.principal.type,
        Role: input.role,
        AssignedBy: _assignedByUserId,
      },
    ],
  });
  return { workflowId };
}

export async function unassignTenantRole(
  deps: RoleAssignmentDeps,
  tenantId: string,
  _unassignedByUserId: string,
  input: RoleAssignmentInput,
): Promise<RoleAssignmentResult> {
  const unassignmentId = (deps.newId ?? randomUUID)();
  const workflowId = `tnt-${tenantId}-role-unassign-${unassignmentId}`;
  await deps.temporal.start("TenantRoleUnassignWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        SubjectID: input.principal.id,
        SubjectType: input.principal.type,
        Role: input.role,
        UnassignedBy: _unassignedByUserId,
      },
    ],
  });
  return { workflowId };
}

// ── groups.list_members (#258) ───────────────────────────────────────────────
//
// Read-side companion to add_member / remove_member (#248). Enumerates
// users currently holding `group#member` on the group. User-only for
// v1 (mirrors the add/remove constraint); nested-group membership uses
// a separate procedure. SpiceDB-only — no DB read.
//
// Tenant scoping: the procedure caller's tRPC ctx already enforces
// `tenant:<id>#read` via tenantProcedure. SpiceDB doesn't expose
// group→tenant on the schema (groups carry tenant in DB only), so
// cross-tenant group-id smuggling would surface a different group's
// members. Mitigation: caller-side enforcement of "group belongs to
// tenant" before invoking is the responsibility of the wire layer.
// V1 trusts the caller; a DB pre-check could land as a follow-up.

export async function listGroupMembers(
  groupId: string,
): Promise<{ users: string[] }> {
  const users = await lookupSubjects(
    { type: "group", id: groupId },
    "member",
    "user",
  );
  return { users };
}

// ── groups.add_member / remove_member (#248) ─────────────────────────────────
//
// Group-membership mutations. User-only for v1; nested-group
// membership is a separate procedure. Same workflow-start pattern as
// roles.assign — DI bag (temporal, newId?) + tnt-prefix convention
// for workflowId.

export interface GroupMembershipInput {
  groupId: string;
  userId: string;
}

export async function addGroupMember(
  deps: RoleAssignmentDeps,
  tenantId: string,
  _addedByUserId: string,
  input: GroupMembershipInput,
): Promise<RoleAssignmentResult> {
  const opId = (deps.newId ?? randomUUID)();
  const workflowId = `tnt-${tenantId}-group-add-member-${opId}`;
  await deps.temporal.start("TenantGroupMemberAddWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        GroupID: input.groupId,
        UserID: input.userId,
        AddedBy: _addedByUserId,
      },
    ],
  });
  return { workflowId };
}

export async function removeGroupMember(
  deps: RoleAssignmentDeps,
  tenantId: string,
  _removedByUserId: string,
  input: GroupMembershipInput,
): Promise<RoleAssignmentResult> {
  const opId = (deps.newId ?? randomUUID)();
  const workflowId = `tnt-${tenantId}-group-remove-member-${opId}`;
  await deps.temporal.start("TenantGroupMemberRemoveWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        GroupID: input.groupId,
        UserID: input.userId,
        RemovedBy: _removedByUserId,
      },
    ],
  });
  return { workflowId };
}

// ── users.suspend / reinstate (#252 + #106 guards) ───────────────────────────
//
// User suspension mutations. Adds the `suspended` relation on the
// tenant for the target user (suspend); removes it (reinstate). The
// user's role relation is NOT touched — reinstate restores the original
// role automatically (suspended subtracts from all permissions per
// packages/auth/schema.zed).
//
// Application-layer guards (#106) layer two checks on top of the v1
// workflow-start dispatch (#252):
//
// 1. Owner-immunity — only an owner OR a platform admin may suspend /
//    reinstate another owner. SpiceDB doesn't enforce this because the
//    target's `transfer_ownership` permission is what marks them as
//    owner; checking it requires a runtime probe, not a schema rule.
//
// 2. Last-owner protection (suspend only) — suspending the last
//    unsuspended owner bricks the tenant. Enumerate tenant#owner
//    subjects, exclude the target, check each remaining owner's
//    `suspended` relation. If 0 unsuspended owners remain, refuse.

// targetIsOwner — true iff the user holds tenant#transfer_ownership.
// transfer_ownership is exclusive to owners per schema.zed (owner →
// transfer_ownership permission; no other role grants it).
async function targetIsOwner(
  tenantId: string,
  userId: string,
): Promise<boolean> {
  return checkRelation(
    { type: "tenant", id: tenantId },
    "transfer_ownership",
    { type: "user", id: userId },
  );
}

// assertCanGovernOwner — used by both suspend + reinstate. Throws
// FORBIDDEN when target is owner AND actor is neither another owner
// nor a platform admin. Silent on non-owner targets and on owner
// targets where the actor is authorized.
export async function assertCanGovernOwner(
  tenantId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  const isOwnerTarget = await targetIsOwner(tenantId, targetUserId);
  if (!isOwnerTarget) return;
  const [actorIsOwner, actorIsPlatformAdmin] = await Promise.all([
    targetIsOwner(tenantId, actorUserId),
    isPlatformAdmin(actorUserId),
  ]);
  if (!actorIsOwner && !actorIsPlatformAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only an owner or platform admin can act on another owner",
    });
  }
}

// assertNotLastOwner — suspend-only. Enumerate user-typed owners of the
// tenant, drop the target, then verify at least one of the remaining
// owners is NOT suspended. Throws FORBIDDEN when 0 unsuspended owners
// would remain post-suspension.
export async function assertNotLastOwner(
  tenantId: string,
  targetUserId: string,
): Promise<void> {
  const owners = await lookupSubjects(
    { type: "tenant", id: tenantId },
    "owner",
    "user",
  );
  const others = owners.filter((id) => id !== targetUserId);
  if (others.length === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Cannot suspend the last owner of this tenant",
    });
  }
  const suspendedFlags = await Promise.all(
    others.map((ownerId) =>
      checkRelation(
        { type: "tenant", id: tenantId },
        "suspended",
        { type: "user", id: ownerId },
      ),
    ),
  );
  const unsuspendedCount = suspendedFlags.filter(
    (suspended) => !suspended,
  ).length;
  if (unsuspendedCount === 0) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Cannot suspend the last unsuspended owner of this tenant",
    });
  }
}

export interface UserSuspensionInput {
  userId: string;
}

export async function suspendUser(
  deps: RoleAssignmentDeps,
  tenantId: string,
  suspendedByUserId: string,
  input: UserSuspensionInput,
): Promise<RoleAssignmentResult> {
  // Guard 1: actor must be authorized to act on the target if target
  // is an owner.
  await assertCanGovernOwner(tenantId, suspendedByUserId, input.userId);
  // Guard 2: refuse when the suspend would leave the tenant with zero
  // unsuspended owners.
  await assertNotLastOwner(tenantId, input.userId);

  const opId = (deps.newId ?? randomUUID)();
  const workflowId = `tnt-${tenantId}-user-suspend-${opId}`;
  await deps.temporal.start("TenantUserSuspendWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        UserID: input.userId,
        SuspendedBy: suspendedByUserId,
      },
    ],
  });
  return { workflowId };
}

export async function reinstateUser(
  deps: RoleAssignmentDeps,
  tenantId: string,
  reinstatedByUserId: string,
  input: UserSuspensionInput,
): Promise<RoleAssignmentResult> {
  // Reinstate skips last-owner check (we're un-suspending, not
  // suspending) but keeps owner-immunity — only owner/platform-admin
  // can flip an owner's suspended state in either direction.
  await assertCanGovernOwner(tenantId, reinstatedByUserId, input.userId);

  const opId = (deps.newId ?? randomUUID)();
  const workflowId = `tnt-${tenantId}-user-reinstate-${opId}`;
  await deps.temporal.start("TenantUserReinstateWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        UserID: input.userId,
        ReinstatedBy: reinstatedByUserId,
      },
    ],
  });
  return { workflowId };
}

// ── roles.change (#236) ──────────────────────────────────────────────────────
//
// Atomic role swap — workflow drives the SpiceDB del+touch in one
// write. Same shape as assign/unassign; input carries oldRole +
// newRole separately so the wire schema can enforce oldRole !==
// newRole + the owner constraint applies to newRole (the role the
// principal is moving TO).

export interface RoleChangeInput {
  principal: { id: string; type: "user" | "service_account" };
  oldRole: TenantRole;
  newRole: TenantRole;
}

export async function changeTenantRole(
  deps: RoleAssignmentDeps,
  tenantId: string,
  _changedByUserId: string,
  input: RoleChangeInput,
): Promise<RoleAssignmentResult> {
  const changeId = (deps.newId ?? randomUUID)();
  const workflowId = `tnt-${tenantId}-role-change-${changeId}`;
  await deps.temporal.start("TenantRoleChangeWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        SubjectID: input.principal.id,
        SubjectType: input.principal.type,
        OldRole: input.oldRole,
        NewRole: input.newRole,
        ChangedBy: _changedByUserId,
      },
    ],
  });
  return { workflowId };
}
