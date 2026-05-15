import { tenantProcedure } from "@monok8s/auth";
import { tenants, type Pool } from "@monok8s/db";
import { router } from "@monok8s/trpc";

import { auditRouter } from "./routers/audit.js";
import { eventsRouter } from "./routers/events.js";
import { grantsRouter } from "./routers/grants.js";
import { principalsRouter } from "./routers/principals.js";
import { tenantsRouter } from "./routers/tenants.js";

// Example tenant-scoped read — demonstrates the canonical pattern
// (kept since #89 landed). Real principal CRUD lives under
// `principals.*` per the AC for #87. Extracted to a named handler
// per Rule 11 (#197); the procedure body is a thin lambda.
const getMyTenant = (db: Pool, tenantSlug: string) =>
  tenants.findBySlug(db, tenantSlug);

export const appRouter = router({
  getMyTenant: tenantProcedure("read").query(({ ctx }) =>
    getMyTenant(ctx.db, ctx.user.tenantId),
  ),

  principals: principalsRouter,
  events: eventsRouter,
  audit: auditRouter,
  grants: grantsRouter,
  tenants: tenantsRouter,
});

export type AppRouter = typeof appRouter;
