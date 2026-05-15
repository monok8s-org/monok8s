// Principal read tRPC procedures (#87a + #87b + #87c).
//
// Handler bodies extracted to `apps/api/src/handlers/principals.ts` per
// Rule 11 (no_buried_chains); this router file owns input parsing +
// tRPC procedure wiring. Every procedure parses raw input via a zod
// schema attached as `.input(Schema)` — the canonical pattern post
// #215 + #230 migration. apps/api/CLAUDE.md rule: "Input validation
// via zod on every procedure — no unvalidated inputs."
//
// Mutations + workflows deferred to per-procedure follow-up Issues
// (each pairs with a Temporal workflow that doesn't exist yet).
//
// Every read uses `tenantProcedure("read")` from @monok8s/auth — which
// verifies the JWT, checks SpiceDB `tenant:<id>#read`, and resolves the
// per-tenant pg.Pool into `ctx.db` before the handler runs.

import { tenantProcedure } from "@monok8s/auth";
import { router } from "@monok8s/trpc";
import { z } from "zod";

import {
  TENANT_ROLES,
  addGroupMember,
  assignTenantRole,
  changeTenantRole,
  createGroup,
  deleteGroup,
  expandPrincipalsForRole,
  getGroup,
  getTenant,
  getUser,
  listGroupMembers,
  listGroupsInTenant,
  listRolesForPrincipal,
  listTenants,
  listUsersInTenant,
  reinstateUser,
  removeGroupMember,
  suspendUser,
  unassignTenantRole,
  updateGroup,
} from "../handlers/principals.js";
import { withTemporal } from "../middleware/temporal.js";

// ── Read-side input schemas (migrated from inline parsers in #230) ──

// Single-id input — consumed by `tenants.get`, `users.get`, `groups.get`.
export const IdInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

// Principal-ref input — consumed by `roles.list_for_principal`. Mirrors
// the SubjectRef shape from @monok8s/auth (id + subject type).
export const PrincipalSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["user", "service_account"]),
  })
  .strict();

// Worked-example zod schema (#215). Exported so the L1 tests can
// .safeParse() it directly and assert the negative cases. Follow-up
// PRs migrate parseId + parsePrincipal to similar exported schemas.
//
// `z.enum(TENANT_ROLES)` requires `as const` on the source tuple
// (handler exports it that way) — the tuple type carries the
// readonly literal-string list zod needs.
export const RoleInputSchema = z.object({
  role: z.enum(TENANT_ROLES),
});

// First mutation schema (#217 / #87 mutation tail). Tenant scoping
// comes from the verified JWT (ctx.user.tenantId), NEVER from the
// wire — so `tenantId` is NOT a schema field.
//
// `name` cap at 128 chars matches a UX-reasonable display ceiling;
// the underlying schema column is TEXT with no length constraint
// per the project DB convention (packages/db/CLAUDE.md). `.strict()`
// rejects unknown fields so smuggling-attempts (e.g. tenant_id on
// input) fail at the wire boundary instead of being silently
// ignored by the handler.
export const CreateGroupSchema = z
  .object({
    name: z.string().min(1).max(128),
    parentGroupId: z.string().uuid().nullable().optional(),
  })
  .strict();

// Update-group schema (#220). At least one of name / parentGroupId
// must be provided — the `.refine` rejects the empty-update case so
// the handler never wastes a round-trip. `parentGroupId: null` is a
// legitimate value (move the group to top-level) so we don't reject
// null — only the all-undefined case.
export const UpdateGroupInputSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(128).optional(),
    parentGroupId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((d) => d.name !== undefined || d.parentGroupId !== undefined, {
    message: "at least one of name / parentGroupId must be provided",
  });

// Delete-group schema (#220). Just the id; tenant scoping happens
// in the handler against the verified JWT.
export const DeleteGroupInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

// Group-membership schema (#248). { groupId, userId } both UUIDs.
// `.strict()` rejects smuggled tenantId/principalType/etc. v1
// supports user-as-member only; nested-group membership uses a
// separate procedure with a different schema.
export const GroupMembershipInputSchema = z
  .object({
    groupId: z.string().uuid(),
    userId: z.string().uuid(),
  })
  .strict();

// User-suspension schema (#252). Just { userId: UUID } — tenant
// scoping comes from the verified JWT. `.strict()` rejects smuggled
// tenantId / reason / etc. v1 doesn't carry a reason field (audit
// trail is captured at the workflow level via the SuspendedBy
// caller-id; a richer audit-reason field is a separate Issue).
export const UserSuspensionInputSchema = z
  .object({
    userId: z.string().uuid(),
  })
  .strict();

// Role-assignment schemas (#234 — PR-2 of roles.assign chain).
// Shared base shape: { principal: { id: UUID, type: enum }, role: enum }.
// .refine() rejects role:"owner" + principal.type:"service_account"
// (schema constraint: owner is user-only per packages/auth/schema.zed).
// .strict() rejects smuggled tenantId or other extras.
const RoleAssignmentBase = z
  .object({
    principal: PrincipalSchema,
    role: z.enum(TENANT_ROLES),
  })
  .strict()
  .refine(
    (d) => !(d.role === "owner" && d.principal.type === "service_account"),
    {
      message: "Service accounts cannot hold the 'owner' role",
      path: ["role"],
    },
  );

export const AssignRoleSchema = RoleAssignmentBase;
export const UnassignRoleSchema = RoleAssignmentBase;

// Role-change schema (#236). Separate base since the shape differs:
// { principal, oldRole, newRole } not { principal, role }. Two
// `.refine()` clauses: oldRole !== newRole (no-op rejection) +
// owner-cannot-be-service_account applied to newRole.
export const ChangeRoleSchema = z
  .object({
    principal: PrincipalSchema,
    oldRole: z.enum(TENANT_ROLES),
    newRole: z.enum(TENANT_ROLES),
  })
  .strict()
  .refine((d) => d.oldRole !== d.newRole, {
    message: "oldRole and newRole must differ",
    path: ["newRole"],
  })
  .refine(
    (d) => !(d.newRole === "owner" && d.principal.type === "service_account"),
    {
      message: "Service accounts cannot hold the 'owner' role",
      path: ["newRole"],
    },
  );

export const principalsRouter = router({
  tenants: router({
    list: tenantProcedure("read").query(({ ctx }) => listTenants(ctx.db)),
    get: tenantProcedure("read")
      .input(IdInputSchema)
      .query(({ ctx, input }) => getTenant(ctx.db, input.id)),
  }),

  users: router({
    // List users in the caller's active tenant. The tenantId comes
    // from the verified JWT, not from input — cross-tenant listing
    // requires the URL-path effectiveTenantId pattern deferred per
    // #89's design discussion.
    list: tenantProcedure("read").query(({ ctx }) =>
      listUsersInTenant(ctx.db, ctx.user.tenantId),
    ),
    get: tenantProcedure("read")
      .input(IdInputSchema)
      .query(({ ctx, input }) => getUser(ctx.db, input.id)),
    // User suspend/reinstate (#252). Workflow-start mutations same
    // shape as roles.assign + groups.add_member — manage_members perm,
    // withTemporal middleware, DI bag. Application-layer owner /
    // last-owner guards land separately (see handler comment).
    suspend: tenantProcedure("manage_members")
      .use(withTemporal)
      .input(UserSuspensionInputSchema)
      .mutation(({ ctx, input }) =>
        suspendUser(
          { temporal: ctx.temporal },
          ctx.user.tenantId,
          ctx.user.userId,
          input,
        ),
      ),
    reinstate: tenantProcedure("manage_members")
      .use(withTemporal)
      .input(UserSuspensionInputSchema)
      .mutation(({ ctx, input }) =>
        reinstateUser(
          { temporal: ctx.temporal },
          ctx.user.tenantId,
          ctx.user.userId,
          input,
        ),
      ),
  }),

  // Groups reads (#87b / #174). Tenant-scoped — `list` enumerates
  // every group in the caller's active tenant; `get` resolves one by
  // id. The groups table from migration 009 carries the structural
  // metadata (name, parent_group_id for nesting); SpiceDB owns the
  // role assignments via `group#membership` subject relations.
  //
  // `create` is the first mutation procedure (#217 / #87 mutation
  // tail kickoff) — uses `tenantProcedure("write")` so the SpiceDB
  // check is `tenant:<id>#write` (vs `#read` for the read procedures).
  // tenantId comes from ctx.user (verified JWT), NEVER from input —
  // CreateGroupSchema is `.strict()` to reject smuggling attempts.
  groups: router({
    list: tenantProcedure("read").query(({ ctx }) =>
      listGroupsInTenant(ctx.db, ctx.user.tenantId),
    ),
    get: tenantProcedure("read")
      .input(IdInputSchema)
      .query(({ ctx, input }) => getGroup(ctx.db, input.id)),
    create: tenantProcedure("write")
      .input(CreateGroupSchema)
      .mutation(({ ctx, input }) =>
        createGroup(ctx.db, ctx.user.tenantId, input),
      ),
    update: tenantProcedure("write")
      .input(UpdateGroupInputSchema)
      .mutation(({ ctx, input }) => {
        const { id, ...rest } = input;
        return updateGroup(ctx.db, ctx.user.tenantId, id, rest);
      }),
    delete: tenantProcedure("write")
      .input(DeleteGroupInputSchema)
      .mutation(({ ctx, input }) =>
        deleteGroup(ctx.db, ctx.user.tenantId, input.id),
      ),
    // groups.list_members (#258) — enumerates the users currently
    // holding `group#member` on the group. Read-side companion to the
    // add_member / remove_member mutations below. tenantProcedure
    // ("read") since this is a read-flavored op.
    list_members: tenantProcedure("read")
      .input(IdInputSchema)
      .query(({ input }) => listGroupMembers(input.id)),
    // Group membership (#248). Workflow-start mutations same shape
    // as roles.assign / change — manage_members perm, withTemporal
    // middleware, DI bag.
    add_member: tenantProcedure("manage_members")
      .use(withTemporal)
      .input(GroupMembershipInputSchema)
      .mutation(({ ctx, input }) =>
        addGroupMember(
          { temporal: ctx.temporal },
          ctx.user.tenantId,
          ctx.user.userId,
          input,
        ),
      ),
    remove_member: tenantProcedure("manage_members")
      .use(withTemporal)
      .input(GroupMembershipInputSchema)
      .mutation(({ ctx, input }) =>
        removeGroupMember(
          { temporal: ctx.temporal },
          ctx.user.tenantId,
          ctx.user.userId,
          input,
        ),
      ),
  }),

  // Role reads (#87c). list_for_principal runs 5 parallel
  // checkRelation calls against each tenant role and collects matches;
  // expand_for_role pairs two lookupSubjects calls (user + service_account)
  // and returns both lists. Both procedures scope to the caller's
  // active tenant via ctx.user.tenantId.
  //
  // assign + unassign are workflow-start mutations (#234 — PR-2 of
  // roles.assign chain). Use tenantProcedure("manage_members") since
  // role-mutation is the canonical manage_members operation per
  // packages/auth/schema.zed. The Temporal workflows
  // (TenantRoleAssign/UnassignWorkflow from #232) do the SpiceDB
  // writes; the API handler ONLY validates + dispatches.
  roles: router({
    list_for_principal: tenantProcedure("read")
      .input(PrincipalSchema)
      .query(({ ctx, input }) =>
        listRolesForPrincipal(ctx.user.tenantId, input),
      ),
    expand_for_role: tenantProcedure("read")
      .input(RoleInputSchema)
      .query(({ ctx, input }) =>
        expandPrincipalsForRole(ctx.user.tenantId, input.role),
      ),
    assign: tenantProcedure("manage_members")
      .use(withTemporal)
      .input(AssignRoleSchema)
      .mutation(({ ctx, input }) =>
        assignTenantRole(
          { temporal: ctx.temporal },
          ctx.user.tenantId,
          ctx.user.userId,
          input,
        ),
      ),
    unassign: tenantProcedure("manage_members")
      .use(withTemporal)
      .input(UnassignRoleSchema)
      .mutation(({ ctx, input }) =>
        unassignTenantRole(
          { temporal: ctx.temporal },
          ctx.user.tenantId,
          ctx.user.userId,
          input,
        ),
      ),
    change: tenantProcedure("manage_members")
      .use(withTemporal)
      .input(ChangeRoleSchema)
      .mutation(({ ctx, input }) =>
        changeTenantRole(
          { temporal: ctx.temporal },
          ctx.user.tenantId,
          ctx.user.userId,
          input,
        ),
      ),
  }),
});
