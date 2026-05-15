// Handler functions for tRPC subscription procedures (#197 — Rule 11
// no_buried_chains; extracted from apps/api/src/routers/events.ts).
//
// Each function returns the observable factory the router wires into
// tenantProcedure.subscription() / authedProcedure.subscription(). Authz
// at connect handshake happens INSIDE the observable callback for
// `workflow` (canOnWorkflow check that depends on the workflowId input);
// for `tenant` + `audit` the SpiceDB check fires upstream in
// tenantProcedure("read"). Plain-function-testable: caller passes the
// relevant context fields explicitly.

import { TRPCError } from "@trpc/server";
import {
  canOnWorkflow,
  type AuditEnvelope,
} from "@monok8s/auth";
import { observable } from "@monok8s/trpc";
import type { Subscription } from "nats";

import { connectNats } from "../nats.js";

export type TenantEvent = {
  tenantId: string;
  event: string;
  timestamp: string;
};

export type WorkflowStatusEvent =
  | {
      scope: "workflow";
      workflowId: string;
      workflowType: string;
      tenantId: string;
      phase: "started" | "succeeded" | "failed" | "cancelled";
      timestamp: string;
      error?: string;
    }
  | {
      scope: "step";
      workflowId: string;
      workflowType: string;
      tenantId: string;
      step: string;
      phase: "started" | "succeeded" | "failed";
      timestamp: string;
      error?: string;
    };

const decoder = new TextDecoder();

// ── tenant subscription ──────────────────────────────────────────────────────

export function subscribeTenantEvents(tenantId: string) {
  const subject = `tenant.${tenantId}.events`;
  return observable<TenantEvent>((emit) => {
    let sub: Subscription | null = null;
    let cancelled = false;

    const ready = (async () => {
      const nc = await connectNats();
      if (cancelled) return;
      sub = nc.subscribe(subject, {
        callback: (err, msg) => {
          if (err) {
            emit.error(err);
            return;
          }
          try {
            emit.next(JSON.parse(decoder.decode(msg.data)) as TenantEvent);
          } catch (e) {
            emit.error(e);
          }
        },
      });
    })().catch((e) => emit.error(e));

    return () => {
      cancelled = true;
      ready.then(() => sub?.unsubscribe()).catch(() => {});
    };
  });
}

// ── workflow subscription ────────────────────────────────────────────────────

export function subscribeWorkflowEvents(userId: string, workflowId: string) {
  const subject = `workflow.${workflowId}.status`;
  return observable<WorkflowStatusEvent>((emit) => {
    let sub: Subscription | null = null;
    let cancelled = false;

    const ready = (async () => {
      // Connect-handshake authz. canOnWorkflow's MVP body parses
      // the tnt-<tid>- prefix and delegates to canOnTenant("read").
      const allowed = await canOnWorkflow(userId, "read", workflowId);
      if (!allowed) {
        emit.error(
          new TRPCError({
            code: "FORBIDDEN",
            message: `missing permission: read on workflow ${workflowId}`,
          }),
        );
        return;
      }
      if (cancelled) return;
      const nc = await connectNats();
      if (cancelled) return;
      sub = nc.subscribe(subject, {
        callback: (err, msg) => {
          if (err) {
            emit.error(err);
            return;
          }
          try {
            emit.next(
              JSON.parse(decoder.decode(msg.data)) as WorkflowStatusEvent,
            );
          } catch (e) {
            emit.error(e);
          }
        },
      });
    })().catch((e) => emit.error(e));

    return () => {
      cancelled = true;
      ready.then(() => sub?.unsubscribe()).catch(() => {});
    };
  });
}

// ── audit subscription ───────────────────────────────────────────────────────

export function subscribeAuditEvents(tenantId: string) {
  const subject = `audit.tenant.${tenantId}`;
  return observable<AuditEnvelope>((emit) => {
    let sub: Subscription | null = null;
    let cancelled = false;

    const ready = (async () => {
      const nc = await connectNats();
      if (cancelled) return;
      sub = nc.subscribe(subject, {
        callback: (err, msg) => {
          if (err) {
            emit.error(err);
            return;
          }
          try {
            emit.next(JSON.parse(decoder.decode(msg.data)) as AuditEnvelope);
          } catch (e) {
            emit.error(e);
          }
        },
      });
    })().catch((e) => emit.error(e));

    return () => {
      cancelled = true;
      ready.then(() => sub?.unsubscribe()).catch(() => {});
    };
  });
}
