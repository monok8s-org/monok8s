// tRPC auth middleware (#89).
//
// Composes verifyToken (zitadel.ts) + canOnTenant (spicedb.ts) +
// poolForTenant (@monok8s/db) into the canonical tRPC procedure
// surface every consumer service uses. Per the AC, this lives in
// packages/auth (not apps/api) so apps/cli and future services can
// reuse the same middleware factory.
//
// Three procedures exported:
//   authedProcedure        — verifies JWT, attaches `user`.
//   tenantProcedure(perm)  — authedProcedure + SpiceDB perm check on
//                            the user's active tenant + resolves the
//                            per-tenant pg.Pool into `ctx.db`.
//   requirePermission(...)  — standalone middleware for non-tenant
//                            resources (installation, system, platform).
//                            Compose AFTER authedProcedure.
//
// Test seams: `_setVerifier_TESTING`, `_setPoolFactory_TESTING` let
// unit tests stub both expensive dependencies without hitting Zitadel
// or the K8s API. `spicedb.ts` already has `_setClient_TESTING` for
// the SpiceDB client.

import { TRPCError } from "@trpc/server";
import { middleware, publicProcedure } from "@monok8s/trpc";
import {
  defaultK8sConfig,
  makeK8sSecretFetcher,
  makePoolFactory,
  type Pool,
} from "@monok8s/db";

import {
  canOnInstallation,
  canOnTenant,
  isPlatformAdmin,
  type InstallationPermission,
  type TenantPermission,
} from "./spicedb.js";
import { hasMFA, verifyToken, type VerifiedUser } from "./zitadel.js";

// ── Audit types (#179 / #88c) ────────────────────────────────────────────────

export type AuditPrincipal = { id: string; type: "user" | "service_account" };
export type AuditTarget = { kind: string; id?: string };
export type AuditOutcome = "success" | "error";

export type AuditEnvelope = {
  principal: AuditPrincipal;
  action: string;
  target: AuditTarget;
  outcome: AuditOutcome;
  error?: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
};

export type AuditEventSpec = {
  action: string;
  target: (input: unknown) => AuditTarget;
  metadata?: (input: unknown, result: unknown) => Record<string, unknown> | undefined;
};

// Auditable ctx — the subset of fields the emitter needs.
export type AuditCtx = {
  db?: Pool;
  user: VerifiedUser;
};

export type AuditEmitter = (ctx: AuditCtx, env: AuditEnvelope) => Promise<void>;

// ── Pool factory (lazy + test seam) ──────────────────────────────────────────

let poolFactory: ((tid: string) => Promise<Pool>) | null = null;

function getPoolFactory(): (tid: string) => Promise<Pool> {
  if (!poolFactory) {
    poolFactory = makePoolFactory({
      fetchSecret: makeK8sSecretFetcher(defaultK8sConfig()),
    });
  }
  return poolFactory;
}

export function _setPoolFactory_TESTING(
  f: ((tid: string) => Promise<Pool>) | null,
): void {
  poolFactory = f;
}

// ── Audit emitter (production wire + test seam) ──────────────────────────────
//
// The audit middleware (#179 / #88c) calls a registered emitter to persist
// + publish the envelope. packages/auth doesn't know about NATS or the pg
// schema; the canonical production emitter lives in apps/api and is
// registered at service startup via setAuditEmitter(...). Unit tests
// register a stub via _setAuditEmitter_TESTING. The default is a no-op +
// warn so unwired callers don't crash but do log loudly.

const defaultAuditEmitter: AuditEmitter = async (_ctx, env) => {
  console.warn(
    "auditMiddleware: no emitter registered; envelope dropped",
    env.action,
  );
};

let auditEmitter: AuditEmitter = defaultAuditEmitter;

export function setAuditEmitter(e: AuditEmitter | null): void {
  auditEmitter = e ?? defaultAuditEmitter;
}

export function _setAuditEmitter_TESTING(e: AuditEmitter | null): void {
  setAuditEmitter(e);
}

// ── Verifier (test seam) ─────────────────────────────────────────────────────

let verifier: (token: string) => Promise<VerifiedUser> = verifyToken;

export function _setVerifier_TESTING(
  f: ((token: string) => Promise<VerifiedUser>) | null,
): void {
  verifier = f ?? verifyToken;
}

// ── authedProcedure ──────────────────────────────────────────────────────────

const authMiddleware = middleware(async ({ ctx, next }) => {
  if (!ctx.token) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "missing bearer token" });
  }
  let user: VerifiedUser;
  try {
    user = await verifier(ctx.token);
  } catch (err) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: err instanceof Error ? err.message : "invalid token",
    });
  }
  return next({ ctx: { ...ctx, user } });
});

export const authedProcedure = publicProcedure.use(authMiddleware);

// ── tenantProcedure ──────────────────────────────────────────────────────────

// tenantProcedure runs authedProcedure + a SpiceDB permission check on
// the user's active tenant + resolves the per-tenant pg.Pool into
// `ctx.db`. Pass `zedToken` from a preceding write to prevent the
// new-enemy problem (see packages/auth/CLAUDE.md "Consistency levels").
//
// Options (#169):
//   - `requireMFA: true` — additionally rejects when the verified
//     user's `amr` claim has no strong-factor marker (mfa / otp /
//     totp / hwk / fido). Useful for sensitive mutations where a
//     password-only login should not suffice.
//
// Two call shapes for backward compatibility with pre-#169 callers:
//   tenantProcedure("read")                      // unchanged
//   tenantProcedure("read", "zedtok-xyz")        // unchanged
//   tenantProcedure("write", { requireMFA: true })   // new
//   tenantProcedure("write", { requireMFA: true, zedToken: "..." })
export interface TenantProcedureOptions {
  requireMFA?: boolean;
  zedToken?: string;
}

function isOptionsArg(
  v: string | TenantProcedureOptions | undefined,
): v is TenantProcedureOptions {
  return typeof v === "object" && v !== null;
}

export function tenantProcedure(
  permission: TenantPermission,
  optsOrZedToken?: string | TenantProcedureOptions,
) {
  const opts: TenantProcedureOptions = isOptionsArg(optsOrZedToken)
    ? optsOrZedToken
    : { zedToken: optsOrZedToken };
  return authedProcedure.use(async ({ ctx, next }) => {
    if (opts.requireMFA && !hasMFA(ctx.user)) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "MFA required",
      });
    }
    const allowed = await canOnTenant(
      ctx.user.userId,
      permission,
      ctx.user.tenantId,
      opts.zedToken,
    );
    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `missing permission: ${permission} on tenant ${ctx.user.tenantId}`,
      });
    }
    const db = await getPoolFactory()(ctx.user.tenantId);
    return next({ ctx: { ...ctx, db } });
  });
}

// ── requirePermission (standalone) ───────────────────────────────────────────

export type PermissionResource =
  | { type: "tenant"; id: string; permission: TenantPermission }
  | { type: "installation"; id: string; permission: InstallationPermission }
  | { type: "platform"; id: string; permission: "administrate" }
  | { type: "system"; id: string; permission: "create_tenants" };

// requirePermission is a standalone middleware factory for permission
// checks on non-tenant resources. Compose AFTER authedProcedure:
//
//   const revokeInstall = authedProcedure
//     .use(requirePermission({ type: "installation", id: "...", permission: "revoke" }))
//     .mutation(...);
//
// For the common tenant-on-active-tenant case, prefer `tenantProcedure(...)`
// which also resolves `ctx.db`.
//
// Same two-shape opts pattern as tenantProcedure (#169):
//   requirePermission(res)
//   requirePermission(res, "zedtok-xyz")
//   requirePermission(res, { requireMFA: true, zedToken: "..." })
export interface RequirePermissionOptions {
  requireMFA?: boolean;
  zedToken?: string;
}

export function requirePermission(
  resource: PermissionResource,
  optsOrZedToken?: string | RequirePermissionOptions,
) {
  const opts: RequirePermissionOptions =
    typeof optsOrZedToken === "object" && optsOrZedToken !== null
      ? optsOrZedToken
      : { zedToken: optsOrZedToken };
  return middleware(async ({ ctx, next }) => {
    const u = (ctx as { user?: VerifiedUser }).user;
    if (!u) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "requirePermission used without authedProcedure upstream",
      });
    }
    if (opts.requireMFA && !hasMFA(u)) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "MFA required",
      });
    }
    let allowed = false;
    switch (resource.type) {
      case "tenant":
        allowed = await canOnTenant(u.userId, resource.permission, resource.id, opts.zedToken);
        break;
      case "installation":
        allowed = await canOnInstallation(
          u.userId,
          resource.permission,
          resource.id,
          opts.zedToken,
        );
        break;
      case "platform":
        allowed = await isPlatformAdmin(u.userId);
        break;
      case "system":
        // canOnSystem isn't a typed helper today; the only system permission
        // is `create_tenants` and only the bootstrap admin has it. Phase-2
        // work could add a typed helper; for now use a placeholder that
        // defers to the existing canOnTenant shape (which won't match
        // system but documents intent).
        allowed = false;
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "system-resource permission checks not yet wired (use packages/auth's CanOnSystem in #145 Go path)",
        });
    }
    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `missing permission: ${resource.permission} on ${resource.type}:${resource.id}`,
      });
    }
    return next();
  });
}

// ── auditMiddleware + auditedMutation (#179 / #88c) ──────────────────────────
//
// Wraps a mutation procedure with audit-log emission. Composes AFTER
// tenantProcedure (which sets ctx.user and ctx.db). The actual emit work
// — pg insert + NATS publish — is plugged in via setAuditEmitter at
// service startup so packages/auth stays decoupled from NATS and the
// audit_log schema.
//
// Mutation-only by contract: applying to a query or subscription throws.
//   - Queries don't modify state; auditing them produces noise.
//   - Subscriptions are long-lived; audit semantics are per-event,
//     and the per-event publish is the publisher's responsibility,
//     not the connect-handshake's.
//
// Emission timing: AFTER the wrapped procedure body runs, success or
// error. The envelope's `timestamp` is the START time so audit log
// entries align with when the mutation began (not when it landed).

export function auditMiddleware(spec: AuditEventSpec) {
  return middleware(async ({ ctx, getRawInput, next, type }) => {
    if (type !== "mutation") {
      throw new Error(
        "auditMiddleware: mutation-only (got " + String(type) + ")",
      );
    }
    const typed = ctx as { user?: VerifiedUser; db?: Pool };
    if (!typed.user) {
      throw new Error(
        "auditMiddleware: requires authedProcedure / tenantProcedure upstream (no ctx.user)",
      );
    }

    // Audit middleware composes via .use(...) which is typically called
    // BEFORE the procedure's .input(parser). At runtime that means the
    // middleware sees `input` as undefined (no upstream parser has run).
    // getRawInput() returns the raw request payload so the target +
    // metadata builders can inspect what the caller submitted.
    const rawInput = await getRawInput();

    const principal: AuditPrincipal = {
      id: typed.user.userId,
      type: "user",
    };
    const target = spec.target(rawInput);
    const startedAt = new Date().toISOString();

    // Capture result OR thrown error without re-typing tRPC's branded
    // MiddlewareResult. The result is returned verbatim at the end so
    // the upstream chain sees the proper opaque type.
    let result: Awaited<ReturnType<typeof next>> | undefined;
    let thrownError: unknown = null;

    try {
      result = await next();
    } catch (e) {
      thrownError = e;
    }

    let outcome: AuditOutcome = "success";
    let errorMessage: string | undefined;
    if (thrownError) {
      outcome = "error";
      errorMessage =
        thrownError instanceof Error ? thrownError.message : String(thrownError);
    } else if (result && !result.ok) {
      outcome = "error";
      const err = (result as unknown as { error?: unknown }).error;
      errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "unknown error";
    }

    const envelope: AuditEnvelope = {
      principal,
      action: spec.action,
      target,
      outcome,
      error: errorMessage,
      metadata: spec.metadata?.(
        rawInput,
        result && result.ok
          ? (result as unknown as { data: unknown }).data
          : undefined,
      ),
      timestamp: startedAt,
    };

    try {
      await auditEmitter({ user: typed.user, db: typed.db }, envelope);
    } catch (emitErr) {
      // Audit-of-audit-failure is out of scope; log + swallow. The
      // mutation outcome must not depend on the audit emitter's health.
      console.error("auditMiddleware: emitter failed", emitErr);
    }

    if (thrownError) throw thrownError;
    return result!;
  });
}

// auditedMutation composes tenantProcedure(permission) + auditMiddleware(spec).
// Usage:
//   auditedMutation('write', {
//     action: 'tenant.update',
//     target: (input) => ({ kind: 'tenant', id: (input as any).tenantId }),
//   })
//     .input(z.object({ ... }))
//     .mutation(async ({ ctx, input }) => { ... });
export function auditedMutation(
  permission: TenantPermission,
  spec: AuditEventSpec,
  zedToken?: string,
) {
  return tenantProcedure(permission, zedToken).use(auditMiddleware(spec));
}
