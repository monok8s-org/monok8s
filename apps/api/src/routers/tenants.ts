// tenantsRouter — tRPC procedures for tenant CRUD (#29).
//
// `tenants.create` is system-permission gated (only members of
// `system:monok8s#create_tenants` may call). Uses `tenantProcedure
// ("read")` because:
//   1. The caller must already be authenticated + scoped to some
//      tenant (typically the admin tenant — the bootstrap admin is a
//      member of `system:monok8s#create_tenants` AND a member of
//      whichever tenant their org spun up first).
//   2. `tenantProcedure` resolves the platform DB pool into `ctx.db`,
//      which the handler needs for the INSERT into the `tenants`
//      table.
//   3. The actual create-tenant gate is `canOnSystem("create_tenants")`
//      inside the handler — running BEYOND the tenantProcedure's
//      generic read check.
//
// `tenants.ping` uses `tenantProcedure("read")` against the target
// tenant — caller must have `tenant:<id>#read` on the queried tenant.

import { tenantProcedure } from "@monok8s/auth";
import { router } from "@monok8s/trpc";
import { z } from "zod";

import {
  createTenant,
  pingTenant,
} from "../handlers/tenants.js";
import { withTemporal } from "../middleware/temporal.js";

// Slug validation: lowercase alphanumeric + hyphens, 3-64 chars,
// matching the DB column constraint (TEXT but conventionally limited).
// .strict() rejects smuggled tenant ids or extra fields.
export const CreateTenantInputSchema = z
  .object({
    slug: z
      .string()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric or hyphen"),
    plan: z.enum(["starter", "pro", "enterprise"]).optional(),
    ownerEmail: z.string().email(),
  })
  .strict();

// pingTenant takes only the target tenant id (validated as UUID).
// tenantProcedure("read") additionally enforces the SpiceDB scope check
// — the caller's tenant context must match the id, OR they must hold
// `tenant:<id>#read` directly.
export const PingTenantInputSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const tenantsRouter = router({
  create: tenantProcedure("read")
    .use(withTemporal)
    .input(CreateTenantInputSchema)
    .mutation(({ ctx, input }) =>
      createTenant(
        { db: ctx.db, temporal: ctx.temporal },
        ctx.user.userId,
        input,
      ),
    ),
  ping: tenantProcedure("read")
    .input(PingTenantInputSchema)
    .query(({ ctx, input }) => pingTenant(ctx.db, input.id)),
});
