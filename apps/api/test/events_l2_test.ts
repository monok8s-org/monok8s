// L2 hermetic integration test for the tRPC tenant-events
// subscription (#88a AC: "L2 itest with apps/api + NATS publishes an
// event, asserts the SSE stream receives it within 1s"; revived from
// the deferred #88a scaffolding now that #178 closes the cross-package
// module resolution gap).
//
// Run under itest_suite with a single nats_server (rules_nats). The
// itest_suite launcher exports NATS_URL pointing at the ephemeral
// instance. The sh wrapper sets MONOK8S_PACKAGES_ROOT for the ESM
// loader hook (tools/bazel/monok8s-esm-loader.mjs) so `@monok8s/*`
// imports resolve to the compiled .js in the runfiles tree.
//
// Test flow:
//   1. Boot the apps/api tRPC HTTP server on an ephemeral port.
//   2. Inject the NATS connection via _setNats_TESTING.
//   3. Stub the auth middleware verifier + SpiceDB client so the
//      tenantProcedure("read") chain passes without real Zitadel /
//      SpiceDB instances (same seam pattern packages/auth's unit
//      tests use; the seam is the production code path's contract).
//   4. Subscribe via @trpc/client over httpSubscriptionLink to
//      `events.tenant`.
//   5. Publish a `tenant.<tid>.events` envelope on NATS via a second
//      connection.
//   6. Assert the client receives the envelope within 1s.

import assert from "node:assert/strict";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { createTRPCClient, httpSubscriptionLink } from "@trpc/client";
import { connect, StringCodec } from "nats";

import {
  _setClient_TESTING,
  _setPoolFactory_TESTING,
  _setVerifier_TESTING,
} from "@monok8s/auth";
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

// Minimal SpiceDB stub — every CheckPermission returns HAS_PERMISSION.
// The unit tests at packages/auth/spicedb.test.ts cover real-client
// paths; this L2 test exercises the SSE+NATS plumbing end-to-end.
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

  // ── Inject auth-middleware test seams BEFORE booting the server ───
  // The middleware chain captures references to these at subscription-
  // connect time; seams must be set first.
  _setVerifier_TESTING(async () => ({
    userId: USER_ID,
    zitadelId: "zitadel-" + USER_ID,
    tenantId: TENANT_ID,
    email: "test@monok8s.test",
  }));
  _setPoolFactory_TESTING(async () => ({}) as never);
  _setClient_TESTING(makeAllowAllSpicedb() as never);

  // Two NATS connections: one for apps/api's events router, one for
  // the test publisher. Both point at the rules_nats-managed server.
  const serverNats = await connect({ servers: NATS_URL });
  const pubNats = await connect({ servers: NATS_URL });
  _setNats_TESTING(serverNats);
  console.log(`[test] NATS connections established (${NATS_URL})`);

  // ── Boot in-process tRPC HTTP server on an ephemeral port ─────────
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

  // ── tRPC client with SSE subscription link ────────────────────────
  // Node 22+ ships a built-in `EventSource`; @trpc/client doesn't
  // auto-discover it (v11 keeps the API server-agnostic). Pass it
  // explicitly via the link options.
  const client = createTRPCClient<AppRouter>({
    links: [
      httpSubscriptionLink({
        url: apiUrl,
        EventSource: globalThis.EventSource,
      }),
    ],
  });

  // ── Subscribe + queue inbound events ──────────────────────────────
  const inbox: unknown[] = [];
  const sub = client.events.tenant.subscribe(undefined, {
    onData: (data) => {
      console.log("[test] onData:", data);
      inbox.push(data);
    },
    onError: (err) => {
      console.error("[test] onError:", err);
    },
  });

  // Allow the SSE handshake to reach steady state before publish; NATS
  // subscriptions registered after the publish window miss messages.
  await new Promise((r) => setTimeout(r, 250));

  // ── Publish the envelope on the canonical subject ─────────────────
  const sc = StringCodec();
  const subject = `tenant.${TENANT_ID}.events`;
  const payload = {
    tenantId: TENANT_ID,
    event: "tenant.created",
    timestamp: new Date().toISOString(),
  };
  pubNats.publish(subject, sc.encode(JSON.stringify(payload)));
  await pubNats.flush();
  console.log(`[test] published to ${subject}`);

  // ── Wait for delivery within 1s (per AC) ──────────────────────────
  const deadline = Date.now() + 1000;
  while (inbox.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(
    inbox.length,
    1,
    `expected 1 envelope within 1s, got ${inbox.length}`,
  );
  const received = inbox[0] as typeof payload;
  assert.equal(received.tenantId, TENANT_ID);
  assert.equal(received.event, "tenant.created");
  console.log("[test] envelope delivered within 1s — AC satisfied");

  // ── Teardown ──────────────────────────────────────────────────────
  sub.unsubscribe();
  await new Promise((r) => setTimeout(r, 100));
  _setNats_TESTING(null);
  _setVerifier_TESTING(null);
  _setPoolFactory_TESTING(null);
  _setClient_TESTING(null);

  await Promise.all([serverNats.close(), pubNats.close()]);
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  console.log("[test] PASS");
}

main().catch((err) => {
  console.error("[test] FAIL:", err);
  process.exit(1);
});
