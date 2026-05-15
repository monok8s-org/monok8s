// Tenant CRUD handlers (#29 — apps/api `tenants.create` + `tenants.ping`).
//
// `tenants.create` is the chain head for new-tenant provisioning:
//   1. INSERT into the `tenants` table (platform DB)
//   2. Enqueue `OnboardTenantWorkflow` on Temporal (workers do the
//      Crossplane XR provisioning + SpiceDB seed + first migrations)
//   3. Return `{ tenantId, workflowId }` so the caller can poll
//
// `tenants.ping` is the demo / smoke endpoint: resolve the tenant by id,
// confirm the caller can read it, return basic shape. The original AC
// (#29) called for resolving the per-tenant DB host from `XTenant.status`
// and opening a connection there — that requires a K8s client in
// apps/api which isn't shipped (and the per-tenant DB only exists post-
// onboarding-workflow). V1 ships a simpler platform-DB ping; the
// per-tenant-DB ping is a follow-up Issue gated on the K8s client wiring.
//
// Both handlers follow the Rule 11 extract-to-plain-function pattern:
// the router file (apps/api/src/routers/tenants.ts) wires them as thin
// lambdas, the test file calls them directly with stub deps.

import { randomUUID } from "node:crypto";

import { TRPCError } from "@trpc/server";
import type { WorkflowClient } from "@temporalio/client";

import { canOnSystem } from "@monok8s/auth";
import {
  tenants as tenantsDb,
  type Pool,
  type Tenant,
} from "@monok8s/db";

export interface CreateTenantInput {
  slug: string;
  plan?: string;
  ownerEmail: string;
}

export interface CreateTenantResult {
  tenantId: string;
  workflowId: string;
}

export interface CreateTenantDeps {
  db: Pool;
  temporal: WorkflowClient;
  // Test seam: override the UUID source for deterministic workflowId
  // composition. Production uses `node:crypto.randomUUID`.
  newId?: () => string;
  // Test seam: override the system-permission check. Production uses
  // `canOnSystem` from `@monok8s/auth`.
  canCreate?: (userId: string) => Promise<boolean>;
}

export async function createTenant(
  deps: CreateTenantDeps,
  actorUserId: string,
  input: CreateTenantInput,
): Promise<CreateTenantResult> {
  // System-permission gate. Per `packages/auth/schema.zed`, only members
  // of `system:monok8s#only_system_can_create_tenants` may create
  // tenants. The bootstrap admin gets this relation at install time
  // (per #145); subsequent grants are an explicit ops action.
  const canCreate = deps.canCreate ?? canOnSystem;
  const permitted = await canCreate(actorUserId, "create_tenants");
  if (!permitted) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only members of system:monok8s#create_tenants can create tenants",
    });
  }

  // INSERT into platform DB first so the tenantId is real before the
  // workflow runs. The workflow's downstream activities reference the
  // tenantId; without the row, those activities can't write the
  // SpiceDB tenant relation or the per-tenant DB.
  const created = await tenantsDb.create(deps.db, {
    slug: input.slug,
    plan: input.plan,
  });

  // Enqueue OnboardTenantWorkflow on the onboarding queue. The
  // workflow's TenantInput shape is { TenantID, Email, Plan } per
  // `apps/workers/onboarding/workflow.go`.
  const workflowId = `tnt-${created.id}-onboard-${(deps.newId ?? randomUUID)()}`;
  await deps.temporal.start("OnboardTenantWorkflow", {
    taskQueue: "onboarding",
    workflowId,
    args: [
      {
        TenantID: created.id,
        Email: input.ownerEmail,
        Plan: input.plan ?? "starter",
      },
    ],
  });

  return { tenantId: created.id, workflowId };
}

// pingTenant — read-only tenant lookup. The caller's tenant-scope
// SpiceDB check happens at the procedure layer (tenantProcedure("read"));
// this handler just reads the row.
//
// V1 returns the platform-DB row; the original #29 AC called for
// resolving the per-tenant DB host and opening a connection there.
// That extension is a follow-up Issue gated on the K8s client wiring
// in apps/api (not currently shipped).
export async function pingTenant(
  db: Pool,
  tenantId: string,
): Promise<Tenant | null> {
  return tenantsDb.findById(db, tenantId);
}
