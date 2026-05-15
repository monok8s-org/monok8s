// Handler functions for the grants tRPC procedures (#224 / #91 local).
//
// Pattern matches apps/api/src/handlers/principals.ts (Rule 11
// no_buried_chains) — plain-call-testable handlers; the router file
// owns input parsing + tRPC procedure wiring.
//
// Handlers stay parameterized over their dependencies (`deps.temporal`,
// `deps.now`) so unit tests inject stubs without touching the real
// WorkflowClient or system clock. Production code passes the values
// from `ctx.temporal` (#222 bootstrap) and `() => new Date()`.

import { randomUUID } from "node:crypto";

import type { WorkflowClient } from "@temporalio/client";

import {
  temporary_grants as grantsDb,
  type Pool,
  type TemporaryGrant,
} from "@monok8s/db";

import type { TenantRole } from "./principals.js";

// Subset of TenantRole that's grantable as a temporary elevation —
// "owner" is excluded per the schema constraint that ownership is
// user-only AND never time-bounded. The schema enforces this too;
// keeping the type narrow here as a safety belt on the handler.
export type GrantableRole = Exclude<TenantRole, "owner">;

export interface CreateTemporaryGrantInput {
  subjectId: string;
  subjectType: "user" | "service_account";
  role: GrantableRole;
  durationSeconds: number;
  reason?: string;
}

export interface CreateTemporaryGrantResult {
  grantId: string;
  expiresAt: string;
  workflowId: string;
}

export interface GrantsDeps {
  temporal: WorkflowClient;
  // Injected so tests can fix the timeline. Production wires
  // `() => new Date()` via the router.
  now: () => Date;
  // Optional UUID generator override — tests pass a deterministic
  // factory to assert workflowId composition. Production uses
  // node:crypto's randomUUID.
  newId?: () => string;
}

// createTemporaryGrant — starts the TemporaryGrantWorkflow on the
// "onboarding" task queue. The workflow is responsible for writing
// the SpiceDB caveat'd relation AND the `temporary_grants` row;
// this handler ONLY validates + dispatches.
//
// Workflow ID convention per #177: `tnt-<tenantId>-grant-<grantId>`.
// The tnt- prefix lets apps/api's canOnWorkflow helper resolve the
// owning tenant for authz on revoke/status reads.
export async function createTemporaryGrant(
  deps: GrantsDeps,
  tenantId: string,
  // grantedByUserId is the caller — reserved for the audit field
  // when the workflow grows to accept it. Currently the Go workflow
  // doesn't take granted_by; logging it here for traceability via
  // the workflow's memo or search-attributes is a follow-up.
  _grantedByUserId: string,
  input: CreateTemporaryGrantInput,
): Promise<CreateTemporaryGrantResult> {
  const grantId = (deps.newId ?? randomUUID)();
  const expiresAt = new Date(
    deps.now().getTime() + input.durationSeconds * 1000,
  ).toISOString();
  const workflowId = `tnt-${tenantId}-grant-${grantId}`;

  await deps.temporal.start("TemporaryGrantWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: tenantId,
        SubjectID: input.subjectId,
        SubjectType: input.subjectType,
        Role: input.role,
        GrantID: grantId,
        ExpiryISO: expiresAt,
      },
    ],
  });

  return { grantId, expiresAt, workflowId };
}

// revokeTemporaryGrant — signals an in-flight TemporaryGrantWorkflow
// to cancel its expiry timer + run the SpiceDB-delete activity early
// (#226 / #92 local). Signal channel name is `"revoke"`, no payload
// per the workflow's contract.
//
// Tenant scoping by workflowId convention: the caller's tenantId from
// ctx.user reconstructs the workflowId. A hostile caller passing
// another tenant's grantId would reconstruct an ID that doesn't exist
// (tnt-<theirTenant>-grant-<otherTenantsGrantId>) — the signal call
// fails with NotFound from Temporal. UUIDv4 collision across tenants
// is negligible. Defense-in-depth (explicit temporary_grants row
// lookup) deferred until telemetry justifies.
//
// revokedByUserId is reserved for future signal payload / search
// attribute carrying the revoker's identity; the workflow's revoke
// activity currently reads granted_by from the DB row, not from a
// signal payload, so the value is logged at the API tier only.
export interface RevokeTemporaryGrantInput {
  grantId: string;
}

export interface RevokeTemporaryGrantResult {
  workflowId: string;
}

export async function revokeTemporaryGrant(
  deps: { temporal: WorkflowClient },
  tenantId: string,
  _revokedByUserId: string,
  input: RevokeTemporaryGrantInput,
): Promise<RevokeTemporaryGrantResult> {
  const workflowId = `tnt-${tenantId}-grant-${input.grantId}`;
  const handle = deps.temporal.getHandle(workflowId);
  await handle.signal("revoke");
  return { workflowId };
}

// ── read side (#228 — completes the grants surface) ──────────────────────────

// listGrants — every temporary_grant row in the caller's tenant.
// Unbounded for v1 (filtering / pagination deferred until the UI
// surface materializes). RLS scopes to tenant_id at the postgres
// layer; the explicit WHERE clause is belt-and-suspenders.
export const listGrants = (db: Pool, tenantId: string) =>
  grantsDb.list(db, tenantId);

// getGrant — single row by id, with tenant scoping. Returns null
// when the row is missing OR belongs to another tenant (same
// posture as updateGroup / deleteGroup — caller can't distinguish
// the two cases by design).
export const getGrant = async (
  db: Pool,
  tenantId: string,
  id: string,
): Promise<TemporaryGrant | null> => {
  const row = await grantsDb.findById(db, id);
  if (row === null || row.tenant_id !== tenantId) return null;
  return row;
};

// updateGrantReason — patches the audit `reason` field on an
// in-flight grant (#244). Pure DB write — reason is an operator-
// facing audit string, not a SpiceDB relation property, so no
// Temporal workflow involved.
//
// Two-step (findById → tenant check → update) mirrors updateGroup /
// deleteGroup: returns null when missing OR cross-tenant; caller
// can't distinguish the two cases by design.
export const updateGrantReason = async (
  db: Pool,
  tenantId: string,
  id: string,
  reason: string | null,
): Promise<TemporaryGrant | null> => {
  const existing = await grantsDb.findById(db, id);
  if (existing === null || existing.tenant_id !== tenantId) return null;
  return grantsDb.updateReason(db, id, reason);
};
