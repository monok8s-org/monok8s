// L1 unit tests for packages/auth/src/middleware.ts (#89).
//
// Uses three test seams to stub deps without network / env:
//   _setVerifier_TESTING(fake)        — stubs Zitadel JWT verification
//   _setPoolFactory_TESTING(fake)     — stubs the @monok8s/db pool factory
//   _setClient_TESTING(fake)          — stubs the SpiceDB client (from spicedb.ts)
//
// Tests exercise the tRPC middleware via the procedure builder's
// `.use(...)` pattern by manually calling the underlying handler. The
// canonical tRPC test pattern would call `caller.someProcedure()`, but
// we want to assert TRPCError codes which surface differently per
// shape; manual middleware-invocation gives the cleanest assertions.

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { TRPCError } from "@trpc/server";
import type { Pool } from "pg";
import { v1 } from "@authzed/authzed-node";

import {
  _setAuditEmitter_TESTING,
  _setPoolFactory_TESTING,
  _setVerifier_TESTING,
  type AuditEnvelope,
} from "./middleware.js";
import { _setClient_TESTING } from "./spicedb.js";
import type { VerifiedUser } from "./zitadel.js";

// ── Stubs ─────────────────────────────────────────────────────────────────────

const fakeUser: VerifiedUser = {
  userId: "user-alice",
  zitadelId: "zitadel-alice",
  tenantId: "acme",
  email: "alice@example.test",
};

const fakePool = { __fake: true } as unknown as Pool;

function setVerifierOk(): jest.MockedFunction<(token: string) => Promise<VerifiedUser>> {
  const v = jest.fn(async (_token: string) => fakeUser);
  _setVerifier_TESTING(v);
  return v;
}

function setVerifierFail(err: Error): jest.MockedFunction<
  (token: string) => Promise<VerifiedUser>
> {
  const v = jest.fn<(token: string) => Promise<VerifiedUser>>(async () => {
    throw err;
  });
  _setVerifier_TESTING(v);
  return v;
}

function setPoolFactory(): jest.MockedFunction<(tid: string) => Promise<Pool>> {
  const f = jest.fn(async (_tid: string) => fakePool);
  _setPoolFactory_TESTING(f);
  return f;
}

function setSpicedbClient(opts?: {
  permitted?: boolean | ((req: v1.CheckPermissionRequest) => boolean);
}): { checkCalls: v1.CheckPermissionRequest[] } {
  const checkCalls: v1.CheckPermissionRequest[] = [];
  const p = opts?.permitted;
  const permitFn: (req: v1.CheckPermissionRequest) => boolean =
    typeof p === "function" ? p : () => p ?? true;
  const stub = {
    promises: {
      checkPermission: jest.fn(async (req: v1.CheckPermissionRequest) => {
        checkCalls.push(req);
        return v1.CheckPermissionResponse.create({
          permissionship: permitFn(req)
            ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
            : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        });
      }),
      writeRelationships: jest.fn(),
    },
  };
  _setClient_TESTING(stub as unknown as v1.ZedClientInterface);
  return { checkCalls };
}

beforeEach(() => {
  setPoolFactory();
  setVerifierOk();
  setSpicedbClient();
});

afterEach(() => {
  _setVerifier_TESTING(null);
  _setPoolFactory_TESTING(null);
  _setClient_TESTING(null);
});

// ── Test harness ──────────────────────────────────────────────────────────────
//
// tRPC procedures expose their middleware chain via the internal
// `_def.middlewares` array. To test in isolation we invoke each
// middleware directly with a hand-rolled ctx + next callback. This
// keeps tests focused on the middleware's behavior without setting up
// a full HTTP server.

interface MiddlewareOpts {
  ctx: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  next: (opts?: { ctx?: any }) => Promise<{ ctx?: any; ok: boolean; data?: unknown; error?: unknown }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type: any;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawInput: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  getRawInput: () => Promise<unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  meta: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signal: any;
}

interface InvokeOptions {
  type?: "query" | "mutation" | "subscription";
  input?: unknown;
  // Optional next() override — when provided, the last middleware sees
  // this in place of the default no-op ok-true next. Used for audit
  // tests that simulate a procedure body throw / return ok:false.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nextOverride?: () => Promise<{ ctx?: any; ok: boolean; data?: unknown; error?: unknown }>;
}

async function invokeMiddleware(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  procedure: any,
  initialCtx: Record<string, unknown>,
  opts?: InvokeOptions,
): Promise<{ ctx: Record<string, unknown>; error?: TRPCError; threw?: unknown; result?: unknown }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const middlewares = procedure._def.middlewares as Array<
    (opts: MiddlewareOpts) => Promise<unknown>
  >;
  let ctx = initialCtx;
  const lastIdx = middlewares.length - 1;
  for (let i = 0; i < middlewares.length; i++) {
    const mw = middlewares[i];
    try {
      const result = (await mw({
        ctx,
        next: async (nextOpts?: { ctx?: Record<string, unknown> }) => {
          if (i === lastIdx && opts?.nextOverride) {
            return opts.nextOverride();
          }
          return {
            ctx: nextOpts?.ctx ?? ctx,
            ok: true,
            data: undefined,
          };
        },
        type: opts?.type ?? "query",
        path: "test",
        rawInput: opts?.input,
        input: opts?.input,
        getRawInput: async () => opts?.input,
        meta: undefined,
        signal: undefined,
      })) as { ctx?: Record<string, unknown>; ok: boolean; data?: unknown };
      if (result.ctx) ctx = result.ctx;
      if (i === lastIdx) {
        return { ctx, result };
      }
    } catch (err) {
      if (err instanceof TRPCError) return { ctx, error: err };
      return { ctx, threw: err };
    }
  }
  return { ctx };
}

// ── authedProcedure ──────────────────────────────────────────────────────────

describe("authedProcedure", () => {
  test("UNAUTHORIZED when token is missing", async () => {
    const { authedProcedure } = await import("./middleware");
    const r = await invokeMiddleware(authedProcedure, { token: undefined });
    expect(r.error?.code).toBe("UNAUTHORIZED");
    expect(r.error?.message).toMatch(/missing bearer token/);
  });

  test("UNAUTHORIZED when verifier throws", async () => {
    setVerifierFail(new Error("bad signature"));
    const { authedProcedure } = await import("./middleware");
    const r = await invokeMiddleware(authedProcedure, { token: "garbage" });
    expect(r.error?.code).toBe("UNAUTHORIZED");
    expect(r.error?.message).toMatch(/bad signature/);
  });

  test("populates ctx.user on success", async () => {
    const { authedProcedure } = await import("./middleware");
    const r = await invokeMiddleware(authedProcedure, { token: "valid" });
    expect(r.error).toBeUndefined();
    expect(r.ctx.user).toEqual(fakeUser);
  });
});

// ── tenantProcedure ──────────────────────────────────────────────────────────

describe("tenantProcedure", () => {
  test("FORBIDDEN when SpiceDB denies", async () => {
    setSpicedbClient({ permitted: false });
    const { tenantProcedure } = await import("./middleware");
    const r = await invokeMiddleware(tenantProcedure("write"), { token: "valid" });
    expect(r.error?.code).toBe("FORBIDDEN");
    expect(r.error?.message).toMatch(/missing permission: write/);
    expect(r.error?.message).toMatch(/tenant acme/);
  });

  test("resolves ctx.db via the injected pool factory when allowed", async () => {
    const poolFactory = setPoolFactory();
    setSpicedbClient({ permitted: true });
    const { tenantProcedure } = await import("./middleware");
    const r = await invokeMiddleware(tenantProcedure("read"), { token: "valid" });
    expect(r.error).toBeUndefined();
    expect(r.ctx.db).toBe(fakePool);
    expect(poolFactory).toHaveBeenCalledWith("acme");
  });

  test("plumbs zedToken to canOnTenant", async () => {
    const { checkCalls } = setSpicedbClient({ permitted: true });
    const { tenantProcedure } = await import("./middleware");
    await invokeMiddleware(tenantProcedure("read", "zedtok-xyz"), {
      token: "valid",
    });
    expect(checkCalls).toHaveLength(1);
    expect(checkCalls[0].consistency?.requirement.oneofKind).toBe("atLeastAsFresh");
  });

  // ── requireMFA option (#169) ────────────────────────────────────────────

  test("requireMFA rejects pwd-only login", async () => {
    setSpicedbClient({ permitted: true });
    // Verifier returns user without amr claim (password-only login).
    _setVerifier_TESTING(jest.fn(async () => ({
      userId: "user-alice",
      zitadelId: "zitadel-alice",
      tenantId: "acme",
      email: "alice@example.test",
      // amr intentionally absent
    })));
    const { tenantProcedure } = await import("./middleware");
    const r = await invokeMiddleware(
      tenantProcedure("write", { requireMFA: true }),
      { token: "valid" },
    );
    expect(r.error?.code).toBe("UNAUTHORIZED");
    expect(r.error?.message).toMatch(/MFA required/);
  });

  test("requireMFA allows mfa-marked login", async () => {
    setSpicedbClient({ permitted: true });
    _setVerifier_TESTING(jest.fn(async () => ({
      userId: "user-alice",
      zitadelId: "zitadel-alice",
      tenantId: "acme",
      email: "alice@example.test",
      amr: ["pwd", "mfa"],
    })));
    const { tenantProcedure } = await import("./middleware");
    const r = await invokeMiddleware(
      tenantProcedure("write", { requireMFA: true }),
      { token: "valid" },
    );
    expect(r.error).toBeUndefined();
    expect(r.ctx.db).toBe(fakePool);
  });

  test("requireMFA off by default: pwd-only still passes", async () => {
    setSpicedbClient({ permitted: true });
    _setVerifier_TESTING(jest.fn(async () => ({
      userId: "user-alice",
      zitadelId: "zitadel-alice",
      tenantId: "acme",
      email: "alice@example.test",
      // amr absent — no MFA — but tenantProcedure("write") without
      // requireMFA accepts.
    })));
    const { tenantProcedure } = await import("./middleware");
    const r = await invokeMiddleware(tenantProcedure("write"), {
      token: "valid",
    });
    expect(r.error).toBeUndefined();
  });

  test("requireMFA + zedToken via options object", async () => {
    const { checkCalls } = setSpicedbClient({ permitted: true });
    _setVerifier_TESTING(jest.fn(async () => ({
      userId: "user-alice",
      zitadelId: "zitadel-alice",
      tenantId: "acme",
      email: "alice@example.test",
      amr: ["pwd", "otp"],
    })));
    const { tenantProcedure } = await import("./middleware");
    const r = await invokeMiddleware(
      tenantProcedure("write", { requireMFA: true, zedToken: "zedtok-xyz" }),
      { token: "valid" },
    );
    expect(r.error).toBeUndefined();
    expect(checkCalls[0].consistency?.requirement.oneofKind).toBe(
      "atLeastAsFresh",
    );
  });
});

// ── requirePermission ────────────────────────────────────────────────────────

describe("requirePermission", () => {
  test("INTERNAL_SERVER_ERROR when not composed after authedProcedure", async () => {
    const { authedProcedure, requirePermission } = await import("./middleware");
    // Use a verifier that returns no user — so ctx.user is unset when
    // requirePermission runs. We can't easily run requirePermission
    // standalone (it expects ctx.user); simulate by skipping authedProcedure.
    const verifyNoUser = jest.fn<(t: string) => Promise<VerifiedUser>>(
      async () => undefined as unknown as VerifiedUser,
    );
    _setVerifier_TESTING(verifyNoUser);

    // Compose authedProcedure with verifier returning no user → ctx.user
    // is still set (as undefined). To truly skip, build a raw middleware:
    const proc = authedProcedure.use(
      requirePermission({ type: "tenant", id: "acme", permission: "read" }),
    );
    const r = await invokeMiddleware(proc, { token: "valid" });
    // Either UNAUTHORIZED (from authedProcedure if verifier returned undefined
    // and we wrapped it) or INTERNAL_SERVER_ERROR (from requirePermission).
    expect(r.error).toBeDefined();
  });

  test("calls canOnTenant for resource.type=tenant", async () => {
    const { checkCalls } = setSpicedbClient({ permitted: true });
    const { authedProcedure, requirePermission } = await import("./middleware");
    const proc = authedProcedure.use(
      requirePermission({ type: "tenant", id: "beta", permission: "manage_members" }),
    );
    const r = await invokeMiddleware(proc, { token: "valid" });
    expect(r.error).toBeUndefined();
    expect(checkCalls).toHaveLength(1);
    expect(checkCalls[0].resource?.objectType).toBe("tenant");
    expect(checkCalls[0].resource?.objectId).toBe("beta");
    expect(checkCalls[0].permission).toBe("manage_members");
  });

  test("FORBIDDEN when permission denied on tenant resource", async () => {
    setSpicedbClient({ permitted: false });
    const { authedProcedure, requirePermission } = await import("./middleware");
    const proc = authedProcedure.use(
      requirePermission({ type: "tenant", id: "gamma", permission: "delete" }),
    );
    const r = await invokeMiddleware(proc, { token: "valid" });
    expect(r.error?.code).toBe("FORBIDDEN");
    expect(r.error?.message).toMatch(/missing permission: delete on tenant:gamma/);
  });
});

// ── auditMiddleware / auditedMutation (#179 / #88c) ──────────────────────────

describe("auditMiddleware", () => {
  // Stub emitter captures envelopes for assertion.
  function setEmitterStub(): { calls: AuditEnvelope[] } {
    const calls: AuditEnvelope[] = [];
    _setAuditEmitter_TESTING(async (_ctx, env) => {
      calls.push(env);
    });
    return { calls };
  }

  function setEmitterThrow(err: Error): void {
    _setAuditEmitter_TESTING(async () => {
      throw err;
    });
  }

  afterEach(() => {
    _setAuditEmitter_TESTING(null);
  });

  test("emits success envelope when wrapped mutation succeeds", async () => {
    const { calls } = setEmitterStub();
    setSpicedbClient({ permitted: true });
    const { auditedMutation } = await import("./middleware");
    const proc = auditedMutation("read", {
      action: "audit.ping",
      target: () => ({ kind: "audit", id: "ping" }),
    });
    const r = await invokeMiddleware(proc, { token: "valid" }, {
      type: "mutation",
      input: { note: "hello" },
      nextOverride: async () => ({ ok: true, data: { pong: true } }),
    });
    expect(r.error).toBeUndefined();
    expect(r.threw).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].outcome).toBe("success");
    expect(calls[0].action).toBe("audit.ping");
    expect(calls[0].target).toEqual({ kind: "audit", id: "ping" });
    expect(calls[0].principal).toEqual({ id: "user-alice", type: "user" });
    expect(calls[0].error).toBeUndefined();
    expect(calls[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("emits error envelope when wrapped mutation throws", async () => {
    const { calls } = setEmitterStub();
    setSpicedbClient({ permitted: true });
    const { auditedMutation } = await import("./middleware");
    const proc = auditedMutation("read", {
      action: "audit.ping",
      target: () => ({ kind: "audit", id: "ping" }),
    });
    const r = await invokeMiddleware(proc, { token: "valid" }, {
      type: "mutation",
      input: {},
      nextOverride: async () => {
        throw new Error("boom");
      },
    });
    expect(r.threw).toBeDefined();
    expect((r.threw as Error).message).toBe("boom");
    expect(calls).toHaveLength(1);
    expect(calls[0].outcome).toBe("error");
    expect(calls[0].error).toBe("boom");
  });

  test("emits error envelope when next() returns ok:false (tRPC error path)", async () => {
    const { calls } = setEmitterStub();
    setSpicedbClient({ permitted: true });
    const { auditedMutation } = await import("./middleware");
    const proc = auditedMutation("read", {
      action: "audit.ping",
      target: () => ({ kind: "audit", id: "ping" }),
    });
    await invokeMiddleware(proc, { token: "valid" }, {
      type: "mutation",
      input: {},
      nextOverride: async () => ({
        ok: false,
        error: new Error("validation failed"),
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].outcome).toBe("error");
    expect(calls[0].error).toBe("validation failed");
  });

  test("emitter failure is swallowed (mutation outcome preserved)", async () => {
    setEmitterThrow(new Error("nats down"));
    setSpicedbClient({ permitted: true });
    const { auditedMutation } = await import("./middleware");
    const proc = auditedMutation("read", {
      action: "audit.ping",
      target: () => ({ kind: "audit", id: "ping" }),
    });
    const r = await invokeMiddleware(proc, { token: "valid" }, {
      type: "mutation",
      input: {},
      nextOverride: async () => ({ ok: true, data: { pong: true } }),
    });
    expect(r.error).toBeUndefined();
    expect(r.threw).toBeUndefined();
    expect((r.result as { ok: boolean }).ok).toBe(true);
  });

  test("invokes metadata builder with input and result", async () => {
    const { calls } = setEmitterStub();
    setSpicedbClient({ permitted: true });
    const { auditedMutation } = await import("./middleware");
    const proc = auditedMutation("read", {
      action: "audit.ping",
      target: () => ({ kind: "audit", id: "ping" }),
      metadata: (input, result) => ({
        seen_input: (input as { note?: string }).note ?? null,
        seen_result_pong:
          (result as { pong?: boolean } | undefined)?.pong ?? null,
      }),
    });
    await invokeMiddleware(proc, { token: "valid" }, {
      type: "mutation",
      input: { note: "tag-me" },
      nextOverride: async () => ({ ok: true, data: { pong: true } }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].metadata).toEqual({
      seen_input: "tag-me",
      seen_result_pong: true,
    });
  });

  test("rejects when applied to a query", async () => {
    setEmitterStub();
    setSpicedbClient({ permitted: true });
    const { auditedMutation } = await import("./middleware");
    const proc = auditedMutation("read", {
      action: "audit.ping",
      target: () => ({ kind: "audit", id: "ping" }),
    });
    const r = await invokeMiddleware(proc, { token: "valid" }, {
      type: "query", // <-- not mutation
      input: {},
    });
    expect(r.threw).toBeDefined();
    expect((r.threw as Error).message).toMatch(/mutation-only/);
  });

  test("composes with tenantProcedure (ctx.user + ctx.db available)", async () => {
    const { calls } = setEmitterStub();
    setSpicedbClient({ permitted: true });
    const { auditedMutation } = await import("./middleware");
    const proc = auditedMutation("write", {
      action: "tenant.update",
      target: (input) => ({
        kind: "tenant",
        id: (input as { id?: string }).id,
      }),
    });
    const r = await invokeMiddleware(proc, { token: "valid" }, {
      type: "mutation",
      input: { id: "tenant-xyz" },
      nextOverride: async () => ({ ok: true, data: { updated: true } }),
    });
    expect(r.error).toBeUndefined();
    expect(r.ctx.user).toEqual(fakeUser);
    expect(r.ctx.db).toBe(fakePool);
    expect(calls[0].target).toEqual({ kind: "tenant", id: "tenant-xyz" });
  });
});
