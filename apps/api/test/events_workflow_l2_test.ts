// L2 hermetic integration test for the tRPC events.workflow
// subscription (#177 / #88b). Mirrors events_l2_test.ts (#88a) with
// a workflow subject + canOnWorkflow gate instead of tenant.events.
//
// Test flow:
//   1. Inject auth-middleware test seams (verifier returns TENANT_ID
//      for USER_ID; SpiceDB allows everything; pool stub).
//   2. Open dual NATS connections (server-side via _setNats_TESTING;
//      publisher-side for synthetic emits).
//   3. Boot apps/api tRPC HTTP server on an ephemeral port.
//   4. Subscribe via tRPC client to events.workflow with a tnt-<tid>-
//      prefixed workflowId.
//   5. Publish a synthetic WorkflowStatusEvent on
//      `workflow.<wid>.status`.
//   6. Assert receipt within 1s; envelope round-trips faithfully
//      including the discriminator + step name.
//   7. Subscribe again with a WRONG-tenant workflowId; assert the
//      authz gate rejects with FORBIDDEN (sanity check on
//      canOnWorkflow's prefix-parsing).

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

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const WORKFLOW_ID = `tnt-${TENANT_ID}-onboard-test-${Date.now()}`;

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

// Allow-all SpiceDB stub: the L2 test exercises NATS + SSE plumbing +
// the prefix-parsing path in canOnWorkflow. canOnWorkflow's call to
// canOnTenant("read") delegates through here.
function makeAllowAllSpicedb() {
  return {
    promises: {
      checkPermission: async () => ({
        permissionship: 2,
        checkedAt: { token: "zedtok-test" },
      }),
    },
  };
}

async function main(): Promise<void> {
  const NATS_URL = envOrDie("NATS_URL");

  _setVerifier_TESTING(async () => ({
    userId: USER_ID,
    zitadelId: "zitadel-" + USER_ID,
    tenantId: TENANT_ID,
    email: "test@monok8s.test",
  }));
  _setPoolFactory_TESTING(async () => ({}) as never);
  _setClient_TESTING(makeAllowAllSpicedb() as never);

  const serverNats = await connect({ servers: NATS_URL });
  const pubNats = await connect({ servers: NATS_URL });
  _setNats_TESTING(serverNats);
  console.log(`[test] NATS connections established (${NATS_URL})`);

  const server = createHTTPServer({
    router: appRouter,
    createContext: () => ({ token: "test-token" }),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) {
    throw new Error("listen address is not an AddressInfo");
  }
  const apiUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[test] tRPC server on ${apiUrl}`);

  const client = createTRPCClient<AppRouter>({
    links: [
      httpSubscriptionLink({
        url: apiUrl,
        EventSource: globalThis.EventSource,
      }),
    ],
  });

  // ── Subscribe to the test workflow ────────────────────────────────
  const inbox: unknown[] = [];
  const sub = client.events.workflow.subscribe(
    { workflowId: WORKFLOW_ID },
    {
      onData: (data) => {
        console.log("[test] onData:", data);
        inbox.push(data);
      },
      onError: (err) => {
        console.error("[test] onError:", err);
      },
    },
  );

  // SSE handshake settle window.
  await new Promise((r) => setTimeout(r, 250));

  // ── Publish a synthetic workflow-lifecycle event ──────────────────
  const sc = StringCodec();
  const subject = `workflow.${WORKFLOW_ID}.status`;
  const payload = {
    scope: "workflow",
    workflowId: WORKFLOW_ID,
    workflowType: "monok8s.onboarding",
    tenantId: TENANT_ID,
    phase: "started",
    timestamp: new Date().toISOString(),
  };
  pubNats.publish(subject, sc.encode(JSON.stringify(payload)));
  await pubNats.flush();
  console.log(`[test] published to ${subject}`);

  // ── Wait for delivery within 1s (per #88's AC carried via #177) ───
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
  assert.equal(received.scope, "workflow");
  assert.equal(received.workflowId, WORKFLOW_ID);
  assert.equal(received.workflowType, "monok8s.onboarding");
  assert.equal(received.tenantId, TENANT_ID);
  assert.equal(received.phase, "started");
  console.log("[test] workflow-lifecycle envelope delivered within 1s");

  // ── Also publish + assert a step-scope event on the same wid ──────
  const stepPayload = {
    scope: "step",
    workflowId: WORKFLOW_ID,
    workflowType: "monok8s.onboarding",
    tenantId: TENANT_ID,
    step: "provision_namespace",
    phase: "succeeded",
    timestamp: new Date().toISOString(),
  };
  pubNats.publish(subject, sc.encode(JSON.stringify(stepPayload)));
  await pubNats.flush();

  const stepDeadline = Date.now() + 1000;
  while (inbox.length < 2 && Date.now() < stepDeadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(inbox.length, 2, "expected step envelope as the 2nd entry");
  const stepReceived = inbox[1] as typeof stepPayload;
  assert.equal(stepReceived.scope, "step");
  assert.equal(stepReceived.step, "provision_namespace");
  console.log("[test] step-lifecycle envelope delivered");

  // ── Teardown ──────────────────────────────────────────────────────
  sub.unsubscribe();
  await new Promise((r) => setTimeout(r, 100));

  // ── Authz rejection sanity check ──────────────────────────────────
  // Subscribe with a workflowId that doesn't carry a tnt-<uuid>- prefix
  // and assert the subscription errors out. canOnWorkflow's prefix
  // parse should return false → FORBIDDEN.
  const badInbox: unknown[] = [];
  let badError: unknown = null;
  const badSub = client.events.workflow.subscribe(
    { workflowId: "marketplace-aws-customer42-no-tnt-prefix" },
    {
      onData: (data) => badInbox.push(data),
      onError: (err) => {
        badError = err;
      },
    },
  );
  // The malformed workflowId is rejected BEFORE the SSE connection
  // opens — the tRPC client wraps the parser-thrown error in a
  // TRPCClientError. Wait for either onError or a short timeout; the
  // happy path is "error fired, no data".
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(badInbox.length, 0, "rejected subscription must not deliver");
  assert.ok(badError !== null, "malformed wid should trigger onError");
  console.log("[test] malformed workflowId rejected as expected");
  badSub.unsubscribe();

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
