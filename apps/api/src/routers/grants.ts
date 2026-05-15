// Grants tRPC router (#224 / #91 local). First consumer of the
// ctx.temporal bootstrap (#222 / PR #223).
//
// `create_temporary` starts the TemporaryGrantWorkflow on the
// "onboarding" task queue — see packages/auth/CLAUDE.md §Temporary
// grants for the full lifecycle (JIT elevation via SpiceDB caveat,
// activity-side DB insert, workflow timer + revoke signal).
//
// Pattern matches the principals + audit routers — zod schema +
// tenantProcedure(...).input(Schema).mutation(...). The handler is
// parameterized over its dependencies so the L1 tests can stub
// the WorkflowClient without going through the procedure builder.

import { tenantProcedure } from "@monok8s/auth";
import { router } from "@monok8s/trpc";
import { z } from "zod";

import {
  createTemporaryGrant,
  getGrant,
  listGrants,
  revokeTemporaryGrant,
  updateGrantReason,
  type GrantableRole,
} from "../handlers/grants.js";
import { TENANT_ROLES } from "../handlers/principals.js";
import { withTemporal } from "../middleware/temporal.js";

// Grantable roles — TENANT_ROLES minus "owner". The schema-zed
// constraint says ownership is user-only AND never time-bounded;
// rejecting "owner" at the wire boundary keeps the workflow input
// safe by construction.
const GRANTABLE_ROLES = TENANT_ROLES.filter(
  (r): r is GrantableRole => r !== "owner",
);

const MIN_DURATION_SECONDS = 1;
const MAX_DURATION_SECONDS = 24 * 60 * 60; // 24h — the JIT-elevation ceiling
const MAX_REASON_LEN = 256;

export const CreateTemporaryGrantSchema = z
  .object({
    subjectId: z.string().uuid(),
    subjectType: z.enum(["user", "service_account"]),
    role: z.enum(GRANTABLE_ROLES as [GrantableRole, ...GrantableRole[]]),
    durationSeconds: z
      .number()
      .int()
      .min(MIN_DURATION_SECONDS)
      .max(MAX_DURATION_SECONDS),
    reason: z.string().max(MAX_REASON_LEN).optional(),
  })
  .strict();

// Revoke-grant schema (#226). Just the grantId — workflowId is
// reconstructed in the handler from convention + caller's tenantId.
export const RevokeTemporaryGrantSchema = z
  .object({
    grantId: z.string().uuid(),
  })
  .strict();

// Get-grant schema (#228). Just the id; tenant scoping happens in
// the handler against the verified JWT.
export const GetGrantInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

// Update-reason schema (#244). Patches just the audit `reason`
// string on an in-flight grant. `.strict()` rejects smuggled fields
// (other grant attributes are NOT mutable via this surface —
// changing role / expiry / status would need separate workflow-
// signal flows per the existing TemporaryGrantWorkflow design).
// reason can be null to clear; otherwise must be a string within
// the schema-checked length cap mirroring create_temporary.
const MAX_REASON_LEN_UPDATE = 256;
export const UpdateGrantReasonInputSchema = z
  .object({
    id: z.string().uuid(),
    reason: z.string().max(MAX_REASON_LEN_UPDATE).nullable(),
  })
  .strict();

export const grantsRouter = router({
  list: tenantProcedure("read").query(({ ctx }) =>
    listGrants(ctx.db, ctx.user.tenantId),
  ),
  get: tenantProcedure("read")
    .input(GetGrantInputSchema)
    .query(({ ctx, input }) =>
      getGrant(ctx.db, ctx.user.tenantId, input.id),
    ),
  create_temporary: tenantProcedure("manage_members")
    .use(withTemporal)
    .input(CreateTemporaryGrantSchema)
    .mutation(({ ctx, input }) =>
      createTemporaryGrant(
        { temporal: ctx.temporal, now: () => new Date() },
        ctx.user.tenantId,
        ctx.user.userId,
        input,
      ),
    ),
  revoke: tenantProcedure("manage_members")
    .use(withTemporal)
    .input(RevokeTemporaryGrantSchema)
    .mutation(({ ctx, input }) =>
      revokeTemporaryGrant(
        { temporal: ctx.temporal },
        ctx.user.tenantId,
        ctx.user.userId,
        input,
      ),
    ),
  // update_reason — operator patches the audit reason on an
  // in-flight grant (#244). Pure DB write, so no .use(withTemporal)
  // needed. tenantProcedure("manage_members") matches the rest of
  // the grants mutations.
  update_reason: tenantProcedure("manage_members")
    .input(UpdateGrantReasonInputSchema)
    .mutation(({ ctx, input }) =>
      updateGrantReason(ctx.db, ctx.user.tenantId, input.id, input.reason),
    ),
});
