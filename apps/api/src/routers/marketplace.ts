import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "@monok8s/trpc";
import { publicProcedure, authedProcedure } from "../middleware/auth";
import { confirmSnsSubscription } from "../effects/sns.js";
import crypto from "node:crypto";

// ── Marketplace router ────────────────────────────────────────────────────────
//
// Handles webhook callbacks from cloud marketplace subscription flows and
// usage metering. Each cloud has a different webhook model:
//
//   AWS:   SaaS subscription SNS notification → resolve token → activate/terminate
//   GCP:   Pub/Sub push from Cloud Commerce → entitlement create/cancel
//   Azure: SaaS fulfillment API webhook → resolve subscription → activate/suspend
//
// In all cases the outcome is the same: create or cancel a monok8s tenant.
// The actual provisioning is delegated to Temporal (OnboardTenantWorkflow or
// OffboardTenantWorkflow). Marketplace-specific metering is submitted by the
// billing worker on a periodic schedule.
//
// Authentication:
//   - AWS:   Verify SNS message signature (X-Amz-Sns-Message-Type header)
//   - GCP:   Verify OIDC bearer token issued by Cloud Commerce service account
//   - Azure: HMAC-SHA256 signature on request body using shared Marketplace token
//   All webhook endpoints are `publicProcedure` — JWT auth does not apply.
//   Instead each uses cloud-specific signature verification.

// ── Shared ────────────────────────────────────────────────────────────────────

const PlanTier = z.enum(["starter", "growth", "enterprise"]);

function planFromMarketplaceSku(sku: string): z.infer<typeof PlanTier> {
  if (sku.includes("enterprise")) return "enterprise";
  if (sku.includes("growth"))     return "growth";
  return "starter";
}

// ── AWS ───────────────────────────────────────────────────────────────────────

// AWS sends an SNS notification when a customer subscribes/unsubscribes.
// We must call ResolveCustomer to exchange the registration token for a
// CustomerIdentifier, then activate the subscription via the Marketplace API.
// Full flow: https://docs.aws.amazon.com/marketplace/latest/userguide/saas-integrate-api.html

const awsSubscribeInput = z.object({
  // Raw SNS message body — parsed after signature verification
  Type:             z.string(),
  MessageId:        z.string(),
  Message:          z.string(), // JSON string containing the action
  Timestamp:        z.string(),
  Signature:        z.string(),
  SigningCertURL:   z.string().url(),
  SubscribeURL:     z.string().url().optional(),
});

export const marketplaceRouter = router({

  // ── AWS subscribe webhook ──────────────────────────────────────────────────
  //
  // Called by AWS SNS when a customer subscribes or unsubscribes.
  // SNS sends a SubscriptionConfirmation first — we must GET SubscribeURL to confirm.
  awsWebhook: publicProcedure
    .input(awsSubscribeInput)
    .mutation(async ({ ctx, input }) => {
      // Verify SNS signature before processing
      await verifyAwsSnsSignature(input);

      if (input.Type === "SubscriptionConfirmation") {
        // Confirm the SNS subscription by hitting the SubscribeURL
        if (!input.SubscribeURL) throw new TRPCError({ code: "BAD_REQUEST", message: "missing SubscribeURL" });
        await confirmSnsSubscription(input.SubscribeURL);
        return { ok: true };
      }

      if (input.Type !== "Notification") {
        return { ok: true }; // ignore other types
      }

      const msg = JSON.parse(input.Message) as {
        action: string;
        "customer-identifier": string;
        "product-code": string;
        "offer-identifier"?: string;
      };

      switch (msg.action) {
        case "subscribe-success": {
          // Customer has been charged — provision the tenant.
          // The registration token from the checkout flow is msg["customer-identifier"].
          // Exchange it for the real customer ID via the Marketplace Metering API.
          const customerId = await resolveAwsMarketplaceCustomer(msg["customer-identifier"]);
          const tenantId = crypto.randomUUID();
          // tnt-<tenantId>- prefix per #177 — tenant is minted above.
          await ctx.temporal.start("OnboardTenantWorkflow", {
            taskQueue: "onboarding",
            workflowId: `tnt-${tenantId}-marketplace-aws-${customerId}`,
            args: [{
              tenantId,
              source: "aws_marketplace",
              marketplaceCustomerId: customerId,
              marketplaceProductCode: msg["product-code"],
              plan: planFromMarketplaceSku(msg["offer-identifier"] ?? ""),
            }],
          });
          return { ok: true, tenantId };
        }
        case "unsubscribe-pending": {
          // Customer cancelled — start offboarding (grace period handled by workflow).
          // TODO(#177): tnt-<tenantId>- prefix once a customerId → tenantId
          // lookup is wired (the offboarding flow needs the tenant anyway).
          // Today the wid form is legacy.
          await ctx.temporal.start("OffboardTenantWorkflow", {
            taskQueue: "onboarding",
            workflowId: "marketplace-aws-offboard-" + msg["customer-identifier"],
            args: [{
              marketplaceSource: "aws",
              marketplaceCustomerId: msg["customer-identifier"],
              reason: "marketplace_cancellation",
            }],
          });
          return { ok: true };
        }
        case "entitlement-updated":
          // Plan change — signal the tenant's billing workflow.
          await ctx.temporal.signal(
            "billing-" + msg["customer-identifier"],
            "entitlementChanged",
            { sku: msg["offer-identifier"] },
          );
          return { ok: true };
        default:
          return { ok: true };
      }
    }),

  // ── GCP Marketplace webhook ────────────────────────────────────────────────
  //
  // Cloud Commerce pushes Pub/Sub messages to this endpoint for entitlement
  // lifecycle events: ENTITLEMENT_CREATION_REQUESTED, ENTITLEMENT_ACTIVE,
  // ENTITLEMENT_CANCELLED, ENTITLEMENT_PLAN_CHANGE_REQUESTED, etc.
  // We must approve/deny creation requests and update billing state on changes.
  gcpWebhook: publicProcedure
    .input(z.object({
      // Pub/Sub push envelope
      message: z.object({
        data:       z.string(), // base64 JSON
        messageId:  z.string(),
        attributes: z.record(z.string()).optional(),
      }),
      subscription: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Verify OIDC token from Cloud Commerce is in Authorization header
      // (checked in HTTP middleware before this handler — ctx.gcpTokenVerified)
      if (!ctx.gcpMarketplaceTokenVerified) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid GCP marketplace token" });
      }

      const payload = JSON.parse(
        Buffer.from(input.message.data, "base64").toString("utf8")
      ) as {
        eventType: string;
        entitlement: {
          id: string;
          name: string;
          account: string;
          product: string;
          plan: string;
          state: string;
        };
      };

      switch (payload.eventType) {
        case "ENTITLEMENT_CREATION_REQUESTED": {
          // Customer clicked "Subscribe" — must approve within 15 minutes.
          const tenantId = crypto.randomUUID();
          // tnt-<tenantId>- prefix per #177.
          await ctx.temporal.start("OnboardTenantWorkflow", {
            taskQueue: "onboarding",
            workflowId: `tnt-${tenantId}-marketplace-gcp-${payload.entitlement.id}`,
            args: [{
              tenantId,
              source: "gcp_marketplace",
              marketplaceEntitlementId: payload.entitlement.id,
              marketplaceAccountId: payload.entitlement.account,
              plan: planFromMarketplaceSku(payload.entitlement.plan),
              // Workflow activity calls Commerce API to approve the entitlement
            }],
          });
          return { ok: true };
        }
        case "ENTITLEMENT_CANCELLED":
        case "ENTITLEMENT_DELETED": {
          // TODO(#177): tnt-<tenantId>- prefix once entitlement → tenant
          // lookup is wired (same shape as AWS offboarding above).
          await ctx.temporal.start("OffboardTenantWorkflow", {
            taskQueue: "onboarding",
            workflowId: "marketplace-gcp-offboard-" + payload.entitlement.id,
            args: [{
              marketplaceSource: "gcp",
              marketplaceEntitlementId: payload.entitlement.id,
              reason: "marketplace_cancellation",
            }],
          });
          return { ok: true };
        }
        case "ENTITLEMENT_PLAN_CHANGED": {
          await ctx.temporal.signal(
            "billing-gcp-" + payload.entitlement.account,
            "entitlementChanged",
            { plan: payload.entitlement.plan },
          );
          return { ok: true };
        }
        default:
          return { ok: true };
      }
    }),

  // ── Azure Marketplace webhook ──────────────────────────────────────────────
  //
  // Azure calls this endpoint for SaaS subscription lifecycle events:
  // Subscribe, Unsubscribe, ChangePlan, ChangeQuantity, Suspend, Reinstate.
  // We must respond 200 within 10 seconds and then call the Operations API
  // to confirm the operation as success/failure.
  azureWebhook: publicProcedure
    .input(z.object({
      id:            z.string(),  // operation ID — must be confirmed via Operations API
      activityId:    z.string(),
      publisherId:   z.string(),
      offerId:       z.string(),
      planId:        z.string(),
      quantity:      z.number().optional(),
      subscriptionId: z.string(),
      timeStamp:     z.string(),
      action:        z.enum([
        "Subscribe", "Unsubscribe", "ChangePlan", "ChangeQuantity",
        "Suspend", "Reinstate", "Transfer",
      ]),
      status:        z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Verify HMAC-SHA256 signature from Azure (checked in HTTP middleware)
      if (!ctx.azureMarketplaceSignatureVerified) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid Azure marketplace signature" });
      }

      switch (input.action) {
        case "Subscribe": {
          // First call resolve the subscription token to get customer details,
          // then start onboarding. The Temporal workflow calls the Operations API
          // to confirm success/failure.
          const tenantId = crypto.randomUUID();
          // tnt-<tenantId>- prefix per #177.
          await ctx.temporal.start("OnboardTenantWorkflow", {
            taskQueue: "onboarding",
            workflowId: `tnt-${tenantId}-marketplace-azure-${input.subscriptionId}`,
            args: [{
              tenantId,
              source: "azure_marketplace",
              marketplaceSubscriptionId: input.subscriptionId,
              marketplaceOperationId: input.id,
              plan: planFromMarketplaceSku(input.planId),
            }],
          });
          return { ok: true };
        }
        case "Unsubscribe":
        case "Suspend": {
          // TODO(#177): tnt-<tenantId>- prefix once subscription → tenant
          // lookup is wired.
          await ctx.temporal.start("OffboardTenantWorkflow", {
            taskQueue: "onboarding",
            workflowId: "marketplace-azure-offboard-" + input.subscriptionId,
            args: [{
              marketplaceSource: "azure",
              marketplaceSubscriptionId: input.subscriptionId,
              marketplaceOperationId: input.id,
              reason: input.action === "Suspend" ? "marketplace_suspend" : "marketplace_cancellation",
            }],
          });
          return { ok: true };
        }
        case "Reinstate": {
          await ctx.temporal.signal(
            "marketplace-azure-" + input.subscriptionId,
            "reinstated",
            { operationId: input.id },
          );
          return { ok: true };
        }
        case "ChangePlan":
        case "ChangeQuantity": {
          await ctx.temporal.signal(
            "billing-azure-" + input.subscriptionId,
            "entitlementChanged",
            { planId: input.planId, quantity: input.quantity, operationId: input.id },
          );
          return { ok: true };
        }
        default:
          return { ok: true };
      }
    }),

  // ── Metering status (internal, platform admin only) ────────────────────────
  //
  // Returns the last metering submission timestamp and any failed batches for
  // a given marketplace source. Used by the ops team to verify metering health.
  meteringStatus: authedProcedure
    .input(z.object({
      source: z.enum(["aws_marketplace", "gcp_marketplace", "azure_marketplace"]),
    }))
    .query(async ({ ctx, input }) => {
      const { canOnPlatform } = await import("@monok8s/auth");
      if (!await canOnPlatform(ctx.user.id, "administrate")) {
        throw new TRPCError({ code: "FORBIDDEN" });
      }
      const rows = await ctx.db.query<{
        last_submitted_at: Date;
        failed_count: number;
        pending_count: number;
      }>(
        `SELECT
           MAX(submitted_at) AS last_submitted_at,
           COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending_count
         FROM marketplace_usage_records
         WHERE source = $1`,
        [input.source],
      );
      return rows[0];
    }),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function verifyAwsSnsSignature(msg: z.infer<typeof awsSubscribeInput>): Promise<void> {
  // Fetch the signing certificate from SigningCertURL and verify the SNS message
  // signature. AWS publishes certs at https://sns.<region>.amazonaws.com/ — reject
  // any cert not from that domain.
  const url = new URL(msg.SigningCertURL);
  if (!url.hostname.endsWith(".amazonaws.com")) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "SNS cert URL not from amazonaws.com" });
  }
  // Full SNS signature verification is ~30 lines; delegate to aws-sns-validator package.
  // Throwing here causes a 500 which SNS retries — intentional for transient cert fetch failures.
  const { validateSnsSignature } = await import("../lib/aws-sns-validator");
  await validateSnsSignature(msg);
}

async function resolveAwsMarketplaceCustomer(registrationToken: string): Promise<string> {
  // Call AWS Marketplace Metering Service ResolveCustomer to exchange the
  // one-time registration token for a durable CustomerIdentifier.
  const { MarketplaceMeteringClient, ResolveCustomerCommand } = await import(
    "@aws-sdk/client-marketplace-metering"
  );
  const client = new MarketplaceMeteringClient({ region: "us-east-1" });
  const result = await client.send(new ResolveCustomerCommand({ RegistrationToken: registrationToken }));
  if (!result.CustomerIdentifier) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "AWS marketplace token resolution failed" });
  }
  return result.CustomerIdentifier;
}
