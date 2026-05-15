import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "@monok8s/trpc";
import { canOnInstallation, canOnTenant } from "@monok8s/auth";
import { authedProcedure, tenantProcedure } from "../middleware/auth";
import { getConfig } from "../config.js";
import { postAlertmanagerAlert } from "../effects/alertmanager.js";

// ── Installation router ───────────────────────────────────────────────────────
//
// Tenant manage_settings → register, revoke, rotate key
// Tenant read            → list, get
// Installation API key   → heartbeat, ingestAlerts (bypasses JWT auth)

export const installationsRouter = router({

  // Create a pending installation record and return a one-time bootstrap token.
  // The tenant admin copies this token to the Model B install CLI.
  register: tenantProcedure("manage_settings")
    .input(z.object({
      name:        z.string().min(1).max(64),
      description: z.string().max(256).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const installationId = crypto.randomUUID();
      const bootstrapToken = crypto.randomUUID(); // raw token — shown once

      // Start the registration workflow — it issues real credentials when the
      // Model B CLI calls activate() with this bootstrap token.
      //
      // Workflow ID prefix `tnt-<tenantId>-` is the project convention per
      // #177: subscribers (events.workflow tRPC) parse the prefix to
      // resolve the owning tenant for authz. canOnWorkflow rejects IDs
      // that don't match the pattern.
      await ctx.temporal.start("InstallationRegistrationWorkflow", {
        taskQueue: "onboarding",
        workflowId: `tnt-${ctx.user.tenantId}-install-register-${installationId}`,
        args: [{
          installationId,
          tenantId: ctx.user.tenantId,
          bootstrapToken,
          // host info unknown at this stage — supplied by Model B CLI at activation
        }],
      });

      // The workflow activity writes the DB record with bootstrap_token_hash.
      return {
        installationId,
        bootstrapToken,  // shown to the admin once, never retrievable again
        expiresIn: "1 hour",
      };
    }),

  // Called by the Model B CLI after exchanging the bootstrap token for credentials.
  // Returns the mTLS cert, CA cert, API key, and endpoint URLs.
  activate: authedProcedure
    .input(z.object({
      installationId: z.string().uuid(),
      bootstrapToken: z.string().uuid(),
      hostCloud:      z.enum(["gcp", "aws", "azure", "bare-metal", "other"]).optional(),
      hostRegion:     z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Signal the registration workflow to proceed with actual credential issuance.
      // Match the workflowId form registered above (#177 convention).
      const handle = ctx.temporal.getHandle(
        `tnt-${ctx.user.tenantId}-install-register-${input.installationId}`,
      );
      const result = await handle.result();
      return result; // InstallationCredentials
    }),

  // List installations for the caller's tenant.
  list: tenantProcedure("read")
    .query(async ({ ctx }) => {
      // DB query — installations for this tenant, newest first
      return ctx.db.query(
        `SELECT id, name, description, status, heartbeat_status,
                last_heartbeat_at, host_cloud, host_region,
                model_b_version, cert_expires_at, api_key_prefix,
                created_at, updated_at
         FROM installations
         WHERE tenant_id = $1 AND status != 'revoked'
         ORDER BY created_at DESC`,
        [ctx.user.tenantId],
      );
    }),

  // Get a single installation (checks SpiceDB `view` permission).
  get: authedProcedure
    .input(z.object({ installationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const allowed = await canOnInstallation(
        ctx.user.userId, "view", input.installationId,
      );
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });

      return ctx.db.queryOne(
        `SELECT * FROM installations WHERE id = $1`,
        [input.installationId],
      );
    }),

  // Revoke an installation — starts InstallationRevocationWorkflow.
  revoke: authedProcedure
    .input(z.object({
      installationId: z.string().uuid(),
      reason:         z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const allowed = await canOnInstallation(
        ctx.user.userId, "revoke", input.installationId,
      );
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });

      const row = await ctx.db.queryOne<{ tenant_id: string }>(
        `SELECT tenant_id FROM installations WHERE id = $1`,
        [input.installationId],
      );

      // tnt-<tenantId>- prefix per #177 (tenantId is looked up via the
      // installation's owning tenant since this route uses authedProcedure
      // rather than tenantProcedure — installation revocation may cross
      // tenants for platform admins).
      await ctx.temporal.start("InstallationRevocationWorkflow", {
        taskQueue: "onboarding",
        workflowId: `tnt-${row.tenant_id}-install-revoke-${input.installationId}`,
        args: [input.installationId, row.tenant_id],
      });
    }),

  // Rotate the API key — issues a new key, invalidates the old one.
  rotateKey: authedProcedure
    .input(z.object({ installationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const allowed = await canOnInstallation(
        ctx.user.userId, "revoke", input.installationId,
      );
      if (!allowed) throw new TRPCError({ code: "FORBIDDEN" });

      // Generate new key, hash it, update DB, return raw key once.
      const newKey = "mk_" + crypto.randomUUID().replace(/-/g, "");
      const hash   = await sha256hex(newKey);
      const prefix = newKey.slice(0, 10);

      await ctx.db.query(
        `UPDATE installations
         SET api_key_hash = $1, api_key_prefix = $2, api_key_rotated_at = now(), updated_at = now()
         WHERE id = $3`,
        [hash, prefix, input.installationId],
      );

      return { apiKey: newKey }; // shown once
    }),

  // ── Unauthenticated endpoints (API key auth via X-Installation-Key header) ──
  // These are called by Model B — no Zitadel JWT, just the installation API key.
  // The API gateway validates the key and injects X-Installation-Id before routing.

  // Heartbeat: Model B POSTs every 5 minutes.
  heartbeat: authedProcedure   // TODO: replace with installationKeyProcedure
    .input(z.object({
      installationId: z.string().uuid(),
      k8sVersion:     z.string().optional(),
      modelBVersion:  z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.query(
        `UPDATE installations
         SET last_heartbeat_at = now(),
             heartbeat_status  = 'healthy',
             k8s_version       = COALESCE($2, k8s_version),
             model_b_version   = COALESCE($3, model_b_version),
             updated_at        = now()
         WHERE id = $1 AND status = 'active'`,
        [input.installationId, input.k8sVersion, input.modelBVersion],
      );

      // Signal the heartbeat monitor workflow.
      // TODO(#177): wrap with `tnt-<installation.tenantId>-` prefix
      // when this procedure adopts installationKeyProcedure (per the
      // line below) and gains the installation→tenant lookup. Today
      // the wid form is legacy; events.workflow subscriptions to
      // heartbeat workflows will not work until this prefix migration
      // completes.
      try {
        await ctx.temporal
          .getHandle("heartbeat-monitor-" + input.installationId)
          .signal("heartbeat");
      } catch {
        // Workflow not running — non-fatal, DB update is the source of truth.
      }

      return { ok: true };
    }),

  // Alert ingestion: Model B Alertmanager webhook.
  // Payload is standard Alertmanager webhook JSON.
  ingestAlerts: authedProcedure   // TODO: replace with installationKeyProcedure
    .input(z.object({
      installationId: z.string().uuid(),
      alerts: z.array(z.object({
        status:      z.enum(["firing", "resolved"]),
        labels:      z.record(z.string()),
        annotations: z.record(z.string()),
        startsAt:    z.string(),
        endsAt:      z.string().optional(),
      })),
    }))
    .mutation(async ({ ctx, input }) => {
      // Look up the tenant for this installation (for notification routing).
      const row = await ctx.db.queryOne<{ tenant_id: string }>(
        `SELECT tenant_id FROM installations WHERE id = $1 AND status = 'active'`,
        [input.installationId],
      );
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });

      // Route to the tenant's notification channels via Model A's Alertmanager.
      // Alerts are forwarded with an `installation_id` label added.
      await forwardToAlertmanager(input.installationId, row.tenant_id, input.alerts);

      return { received: input.alerts.length };
    }),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function forwardToAlertmanager(
  installationId: string,
  tenantId: string,
  alerts: unknown[],
): Promise<void> {
  const labelled = (alerts as Array<{ labels: Record<string, string> }>).map(a => ({
    ...a,
    labels: { ...a.labels, installation_id: installationId, tenant_id: tenantId },
  }));

  // URL resolved at module-load boundary via apps/api/src/config.ts
  // (#195 — Locality). getConfig() returns the cached AppConfig the
  // createContext call also reads from; passing it directly here
  // keeps the boundary read single-sourced.
  const alertmanagerUrl = getConfig().alertmanagerUrl;
  await postAlertmanagerAlert(alertmanagerUrl, labelled);
}
