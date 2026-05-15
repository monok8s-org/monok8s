// Production audit emitter (#179 / #88c) — registers the canonical
// pg-insert + NATS-publish emitter against the audit middleware seam
// from packages/auth.
//
// The emitter is registered explicitly at service startup (apps/api/src/
// index.ts) and at L2 itest setup. packages/auth doesn't reach into
// apps/api; this module is the bridge.
//
// Emission contract:
//   1. INSERT one row into `audit_log` via ctx.db (the per-tenant pool
//      resolved by tenantProcedure).
//   2. PUBLISH the envelope JSON to `audit.tenant.<tenantId>` on NATS.
//
// Both steps are best-effort: each is wrapped in try/catch and failures
// log + swallow. The mutation outcome MUST NOT depend on the audit
// emitter's health (the audit middleware itself also catches emitter
// throws; the inner try/catch is belt-and-suspenders).
//
// RLS note: the audit_log table has `tenant_id` RLS keyed on
// current_setting('app.tenant_id')::uuid. As of #179 the per-tenant pool
// does NOT set `app.tenant_id` on connection — RLS is defensive future-
// state for when the broader tenant-context-on-pool work (#85 successor)
// lands. The emitter therefore inserts plain rows with `tenant_id`
// column explicit; RLS enforcement attaches when the pool wires set the
// session variable.

import { setAuditEmitter, type AuditEmitter } from "@monok8s/auth";

import { connectNats } from "./nats.js";

const encoder = new TextEncoder();

const productionAuditEmitter: AuditEmitter = async (ctx, env) => {
  // ── pg INSERT ───────────────────────────────────────────────────────
  if (ctx.db) {
    try {
      await ctx.db.query(
        `INSERT INTO audit_log
           (tenant_id, principal_id, principal_type, action,
            target_kind, target_id, outcome, error_message,
            metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          ctx.user.tenantId,
          env.principal.id,
          env.principal.type,
          env.action,
          env.target.kind,
          env.target.id ?? null,
          env.outcome,
          env.error ?? null,
          env.metadata ? JSON.stringify(env.metadata) : null,
          env.timestamp,
        ],
      );
    } catch (e) {
      console.error("audit_emitter: pg INSERT failed", {
        action: env.action,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    // No pool means tenantProcedure didn't run; this can happen if
    // auditMiddleware is composed without tenantProcedure upstream
    // (a configuration error). Don't crash; surface via log.
    console.warn("audit_emitter: ctx.db absent; skipping pg INSERT", env.action);
  }

  // ── NATS publish ────────────────────────────────────────────────────
  try {
    const nc = await connectNats();
    const subject = `audit.tenant.${ctx.user.tenantId}`;
    nc.publish(subject, encoder.encode(JSON.stringify(env)));
  } catch (e) {
    console.error("audit_emitter: NATS publish failed", {
      action: env.action,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};

// Called once at apps/api startup (or at L2 itest setup) to register the
// production emitter against the packages/auth audit middleware seam.
export function wireProductionAudit(): void {
  setAuditEmitter(productionAuditEmitter);
}

// Exported for direct test invocation (e.g. asserting emitter shape
// from a unit test that doesn't go through the middleware).
export { productionAuditEmitter };
