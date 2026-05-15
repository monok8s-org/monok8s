// Handler functions for the audit router (#197 — Rule 11
// no_buried_chains; extracted from apps/api/src/routers/audit.ts).
//
// Two surface areas today:
//   - pingAudit (#197 / #88c) — self-test mutation that exercises
//     the audit chain end-to-end.
//   - listAuditEvents (#208) — paginated read of historical audit_log
//     rows; sibling to the events.audit subscription. Powers #94's
//     audit-view UI.

import {
  audit as auditDb,
  type AuditLog,
  type AuditListFilters,
  type Pool,
} from "@monok8s/db";

export type { AuditLog, AuditListFilters };

export interface PingResult {
  pong: true;
  tenantId: string;
  note: string | null;
  at: string;
}

export function pingAudit(tenantId: string, note: string | undefined): PingResult {
  return {
    pong: true,
    tenantId,
    note: note ?? null,
    at: new Date().toISOString(),
  };
}

// listAuditEvents — thin pass-through to packages/db's audit.list.
// Kept as a named handler (rather than inlining in the router) per
// Rule 11 so the procedure body stays a thin lambda and the read is
// plain-call-testable from L1 with a stub Pool.
export async function listAuditEvents(
  db: Pool,
  filters: AuditListFilters,
): Promise<AuditLog[]> {
  return auditDb.list(db, filters);
}
