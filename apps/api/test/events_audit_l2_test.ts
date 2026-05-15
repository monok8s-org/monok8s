// L2 hermetic integration test for the tRPC audit pipeline (#179 / #88c
// AC: "L2 itest: invoke a mutation procedure → assert audit_log row
// inserted AND SSE stream receives the audit envelope").
//
// Run under itest_suite with two servers — nats_server (rules_nats) and
// pg_server (rules_pg). Migration 008 (audit_log) is applied at test
// startup from the SQL path exported by the launcher via
// MONOK8S_AUDIT_LOG_SQL.
//
// Test flow:
//   1. Apply migration 008 against the ephemeral pg to create audit_log.
//   2. Boot the apps/api tRPC HTTP server on an ephemeral port.
//   3. Wire the production audit emitter (pg insert + NATS publish).
//   4. Stub the auth seams so tenantProcedure("read") passes without
//      Zitadel / SpiceDB / K8s — pool factory returns a real pg.Pool
//      against the ephemeral pg.
//   5. Subscribe to events.audit via SSE.
//   6. Invoke audit.ping({ note: "l2-itest" }) via the tRPC client.
//   7. Within 2s, assert the SSE inbox received the envelope AND the
//      audit_log row landed.
//
// Two NATS connections: one for apps/api's events router (and emitter
// publish), one for the SSE subscription consumer. Both point at the
// rules_nats-managed instance.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from "@trpc/client";
import { connect } from "nats";
import { Pool } from "pg";

import {
  _setClient_TESTING,
  _setPoolFactory_TESTING,
  _setVerifier_TESTING,
  type AuditEnvelope,
} from "@monok8s/auth";
import { wireProductionAudit } from "../src/audit_emitter.js";
import { _setNats_TESTING } from "../src/nats.js";
import type { AppRouter } from "../src/router.js";
import { appRouter } from "../src/router.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "11111111-1111-1111-1111-111111111111";

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

function makeAllowAllSpicedb() {
  return {
    promises: {
      checkPermission: async () => ({
        permissionship: 2, // PERMISSIONSHIP_HAS_PERMISSION
        checkedAt: { token: "zedtok-test" },
      }),
    },
  };
}

async function main(): Promise<void> {
  const NATS_URL = envOrDie("NATS_URL");
  const PG_URL = envOrDie("PG_URL");
  const AUDIT_LOG_SQL = envOrDie("MONOK8S_AUDIT_LOG_SQL");

  // ── Apply migration 008 to the ephemeral pg ───────────────────────
  const adminPool = new Pool({ connectionString: PG_URL });
  const ddl = readFileSync(AUDIT_LOG_SQL, "utf-8");
  await adminPool.query(ddl);
  console.log("[test] applied audit_log migration");

  // ── Auth-middleware seams ─────────────────────────────────────────
  _setVerifier_TESTING(async () => ({
    userId: USER_ID,
    zitadelId: "zitadel-" + USER_ID,
    tenantId: TENANT_ID,
    email: "test@monok8s.test",
  }));
  // Pool factory returns the same pg pool for the tenant — RLS isn't
  // enforced in this test (the rules_pg user is the superuser so it
  // bypasses policies; that's fine here — we assert tenant_id column
  // values directly).
  _setPoolFactory_TESTING(async () => adminPool);
  _setClient_TESTING(makeAllowAllSpicedb() as never);

  // ── NATS connections ──────────────────────────────────────────────
  const serverNats = await connect({ servers: NATS_URL });
  const consumerNats = await connect({ servers: NATS_URL });
  _setNats_TESTING(serverNats);
  console.log(`[test] NATS connections established (${NATS_URL})`);

  // ── Wire the production audit emitter ─────────────────────────────
  // Same path index.ts uses; here the dependencies (ctx.db, connectNats)
  // both point at hermetic fixtures via the seams above.
  wireProductionAudit();

  // ── Boot in-process tRPC HTTP server ──────────────────────────────
  const server = createHTTPServer({
    router: appRouter,
    createContext: () => ({ token: "test-token" }),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("listen address is not an AddressInfo");
  }
  const apiUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[test] tRPC server on ${apiUrl}`);

  // ── tRPC client with split link (mutations + subscriptions) ───────
  // httpSubscriptionLink handles subscriptions only; mutations go via
  // httpBatchLink. splitLink dispatches by op.type.
  const client = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === "subscription",
        true: httpSubscriptionLink({
          url: apiUrl,
          EventSource: globalThis.EventSource,
        }),
        false: httpBatchLink({ url: apiUrl }),
      }),
    ],
  });

  // ── Subscribe to events.audit + queue inbound envelopes ───────────
  const inbox: AuditEnvelope[] = [];
  const sub = client.events.audit.subscribe(undefined, {
    onData: (data) => {
      console.log("[test] onData:", data);
      inbox.push(data);
    },
    onError: (err) => {
      console.error("[test] onError:", err);
    },
  });

  // Allow SSE handshake to reach steady state; NATS subscriptions
  // registered after publish miss messages.
  await new Promise((r) => setTimeout(r, 300));

  // ── Invoke audit.ping ─────────────────────────────────────────────
  const result = await client.audit.ping.mutate({ note: "l2-itest" });
  assert.equal(result.pong, true);
  assert.equal(result.tenantId, TENANT_ID);
  assert.equal(result.note, "l2-itest");
  console.log("[test] audit.ping mutation returned:", result);

  // ── Wait for SSE delivery within 2s ───────────────────────────────
  const deadline = Date.now() + 2000;
  while (inbox.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(
    inbox.length,
    1,
    `expected 1 audit envelope within 2s, got ${inbox.length}`,
  );
  const env = inbox[0];
  assert.equal(env.action, "audit.ping");
  assert.equal(env.outcome, "success");
  assert.equal(env.target.kind, "audit");
  assert.equal(env.target.id, "ping");
  assert.equal(env.principal.id, USER_ID);
  assert.equal(env.principal.type, "user");
  assert.deepEqual(env.metadata, { note: "l2-itest" });
  console.log("[test] SSE envelope received within 2s — AC#1 satisfied");

  // ── Assert audit_log row landed ───────────────────────────────────
  const { rows } = await adminPool.query<{
    tenant_id: string;
    principal_id: string;
    principal_type: string;
    action: string;
    target_kind: string;
    target_id: string | null;
    outcome: string;
    error_message: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT tenant_id, principal_id, principal_type, action,
            target_kind, target_id, outcome, error_message, metadata
     FROM audit_log
     WHERE action = $1`,
    ["audit.ping"],
  );
  assert.equal(rows.length, 1, `expected 1 audit_log row, got ${rows.length}`);
  const row = rows[0];
  assert.equal(row.tenant_id, TENANT_ID);
  assert.equal(row.principal_id, USER_ID);
  assert.equal(row.principal_type, "user");
  assert.equal(row.action, "audit.ping");
  assert.equal(row.target_kind, "audit");
  assert.equal(row.target_id, "ping");
  assert.equal(row.outcome, "success");
  assert.equal(row.error_message, null);
  assert.deepEqual(row.metadata, { note: "l2-itest" });
  console.log("[test] audit_log row landed — AC#2 satisfied");

  // ── Teardown ──────────────────────────────────────────────────────
  sub.unsubscribe();
  await new Promise((r) => setTimeout(r, 100));
  _setNats_TESTING(null);
  _setVerifier_TESTING(null);
  _setPoolFactory_TESTING(null);
  _setClient_TESTING(null);

  await Promise.all([serverNats.close(), consumerNats.close()]);
  await adminPool.end();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  console.log("[test] PASS");
}

main().catch((err) => {
  console.error("[test] FAIL:", err);
  process.exit(1);
});
