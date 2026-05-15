// Audit-infrastructure self-test router (#179 / #88c).
//
// `audit.ping` is a thin mutation that exists to exercise the full
// audit chain end-to-end: tenantProcedure → auditMiddleware → emitter
// (pg INSERT into audit_log + NATS publish to audit.tenant.<tid>) →
// SSE subscriber on events.audit.
//
// This is real production code, not a synthetic test fixture: any
// operator can hit `audit.ping` from a deployed environment to verify
// the audit pipeline is wired correctly without having to wait for a
// real mutation to land. Comparable to a `/healthz` for the audit
// subsystem.
//
// The procedure deliberately:
//   - Requires `read` permission on the caller's tenant (not `write`)
//     — pinging audit infrastructure shouldn't itself require write
//     privileges; that's intentional so audit-readers can self-test
//     the path.
//   - Echoes the input note (≤64 chars) into the result so operators
//     can correlate the call with the resulting audit_log row.
//   - Records action="audit.ping", target={kind:"audit", id:"ping"}.
//
// Adding more audit-infrastructure self-tests in future: keep them
// scoped to audit observability (e.g. audit.metrics, audit.echo) and
// keep them mutation-only — auditMiddleware is mutation-only by
// contract.

import { auditedMutation, tenantProcedure } from "@monok8s/auth";
import { router } from "@monok8s/trpc";
import { z } from "zod";

import { listAuditEvents, pingAudit } from "../handlers/audit.js";

// ── Wire-boundary input schemas (migrated from inline parsers in #230) ──

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
const MAX_ACTION_LEN = 128;

// audit.ping input — { note?: string ≤64 }. `.strict()` rejects
// smuggled fields at the wire boundary.
export const PingInputSchema = z
  .object({
    note: z.string().max(64).optional(),
  })
  .strict();

// audit.list filter input. Datetime uses zod's RFC 3339 validator
// (`{ offset: true }` accepts both `Z` and `±HH:MM` offsets, matching
// the original regex). The limit field clamps to MAX_LIMIT via
// `.transform()` so callers requesting oversized pages get the cap
// silently rather than a hard rejection — preserves the v1
// operator-UX-friendly behavior from the inline parser.
export const AuditListInputSchema = z
  .object({
    action: z.string().min(1).max(MAX_ACTION_LEN).optional(),
    principalId: z.string().uuid().optional(),
    before: z.string().datetime({ offset: true }).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .transform((v) => Math.min(v, MAX_LIMIT))
      .optional(),
  })
  .strict()
  .transform((parsed) => ({
    ...parsed,
    limit: parsed.limit ?? DEFAULT_LIMIT,
  }));

export const auditRouter = router({
  ping: auditedMutation("read", {
    action: "audit.ping",
    target: () => ({ kind: "audit", id: "ping" }),
    metadata: (input) => {
      const parsed = PingInputSchema.parse(input);
      return parsed.note ? { note: parsed.note } : undefined;
    },
  })
    .input(PingInputSchema)
    .mutation(({ ctx, input }) => pingAudit(ctx.user.tenantId, input.note)),

  // Historical-list half of the audit surface (#208). Pairs with the
  // events.audit live-tail subscription (#88c / PR #184) — the UI
  // composes "show me the last 50 envelopes, append newer ones live."
  list: tenantProcedure("read")
    .input(AuditListInputSchema)
    .query(({ ctx, input }) => listAuditEvents(ctx.db, input)),
});
