// withTemporal middleware (#224 / follow-on to #222 / PR #223).
//
// Adds `temporal: WorkflowClient` to ctx so mutation procedures can
// start workflows via `ctx.temporal.start(...)`. The bootstrap PR
// (#222) wired the WorkflowClient into AppContext, but tRPC's
// procedure-builder type inference is parameterized over the minimal
// BaseContext from @monok8s/trpc — so AppContext fields aren't
// visible to handler signatures unless explicitly added via
// middleware.
//
// Per packages/trpc/src/context.ts's design note: "apps/api enriches
// it via middleware (authMiddleware adds `user`; route-specific
// middleware adds `temporal`, `db`, ...)." This module is the
// canonical implementation of that design intent.
//
// Compose AFTER tenantProcedure (or authedProcedure) — the JWT +
// SpiceDB check must run first so unauthenticated callers don't
// trigger a Temporal connection attempt for a request that's going
// to be rejected:
//
//   tenantProcedure("manage_members")
//     .use(withTemporal)
//     .input(Schema)
//     .mutation(({ ctx, input }) => /* ctx.temporal is now visible */)

import { middleware } from "@monok8s/trpc";

import { getTemporalClient } from "../temporal.js";

export const withTemporal = middleware(async ({ ctx, next }) => {
  const temporal = await getTemporalClient();
  return next({ ctx: { ...ctx, temporal } });
});
