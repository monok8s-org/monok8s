// tRPC subscription procedures over NATS+SSE (#88a + #88b + #88c).
//
// Per Discussion #76: "tRPC v11 subscriptions over SSE land naturally
// on this — subscribing to trpc.workflow.events registers a NATS
// subscriber per connection; unsubscribe tears it down."
//
// Subject + envelope contract for `tenant` (#88a):
//   subject = `tenant.<tenantId>.events`
//   envelope = { tenantId: string, event: string, timestamp: string }
// Publisher: apps/workers/onboarding/activities_emit.go (#126).
//
// Subject + envelope contract for `workflow` (#88b / #177):
//   subject = `workflow.<workflowId>.status`
//   envelope = WorkflowStatusEvent — discriminated union of workflow
//              vs step lifecycle events; carries workflowType + step
//              from day one for forward-compat with tenant-built
//              workflows (named workflow types + Pedestal-shaped
//              named steps).
// Publisher: apps/workers/onboarding/activities_workflow_status.go
// (EmitWorkflowStatusActivity). OnboardTenantWorkflow emits ~10
// envelopes per execution (workflow lifecycle + per-step).
//
// Subject + envelope contract for `audit` (#88c / #179):
//   subject = `audit.tenant.<tenantId>`
//   envelope = AuditEnvelope from @monok8s/auth — { principal, action,
//              target, outcome, error?, metadata?, timestamp }.
// Publisher: packages/auth's auditMiddleware via the production emitter
// registered in apps/api/src/audit_emitter.ts. Every mutation procedure
// wired with `auditedMutation(...)` (today: audit.ping; future: every
// activated mutation in principals / installations / marketplace)
// publishes one envelope per call (success or error).
//
// Handler bodies extracted to ../handlers/events.ts per Rule 11
// (no_buried_chains; #197). Each procedure body here is a thin lambda
// that threads ctx + input into the named subscription factory.

import { authedProcedure, tenantProcedure } from "@monok8s/auth";
import { router } from "@monok8s/trpc";

import {
  subscribeAuditEvents,
  subscribeTenantEvents,
  subscribeWorkflowEvents,
  type TenantEvent,
  type WorkflowStatusEvent,
} from "../handlers/events.js";

// Re-export the envelope types so existing consumers
// (events.test.ts, frontend types) don't have to update import paths.
export type { TenantEvent, WorkflowStatusEvent };

// Project convention (#177): workflow IDs start with `tnt-<uuid>-`.
// The authz helper canOnWorkflow parses this prefix to resolve the
// owning tenant. parseWorkflowIdInput enforces the shape at the API
// boundary so invalid IDs fail fast before any SpiceDB call.
const WORKFLOW_ID_RE =
  /^tnt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9_-]+$/i;

export type WorkflowIdInput = { workflowId: string };

function parseWorkflowIdInput(input: unknown): WorkflowIdInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("expected { workflowId }");
  }
  const wid = (input as { workflowId?: unknown }).workflowId;
  if (typeof wid !== "string" || !WORKFLOW_ID_RE.test(wid)) {
    throw new Error("workflowId must match `tnt-<uuid>-<suffix>`");
  }
  return { workflowId: wid };
}

export const eventsRouter = router({
  // tenant — live-tail tenant lifecycle envelopes for the caller's
  // active tenant. Authz via tenantProcedure("read") fires at connect
  // handshake (the same SpiceDB check used by principal reads).
  tenant: tenantProcedure("read").subscription(({ ctx }) =>
    subscribeTenantEvents(ctx.user.tenantId),
  ),

  // workflow — live-tail workflow + step lifecycle envelopes for one
  // workflow instance (#88b / #177). Uses authedProcedure (NOT
  // tenantProcedure) because the workflow's tenant is parsed from the
  // workflowId via canOnWorkflow; platform admins subscribing
  // cross-tenant pass through schema.zed's `+ platform->administrate`
  // bypass on canOnTenant.
  workflow: authedProcedure
    .input(parseWorkflowIdInput)
    .subscription(({ ctx, input }) =>
      subscribeWorkflowEvents(ctx.user.userId, input.workflowId),
    ),

  // audit — live-tail audit envelopes for the caller's active tenant
  // (#88c / #179). Same connect-handshake authz as `tenant`: the SpiceDB
  // check fires inside tenantProcedure("read") before the NATS
  // subscription is registered. Envelope shape comes from packages/auth
  // (AuditEnvelope) so the wire format is owned by the audit subsystem,
  // not duplicated here.
  audit: tenantProcedure("read").subscription(({ ctx }) =>
    subscribeAuditEvents(ctx.user.tenantId),
  ),
});
