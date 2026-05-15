// NATS connection singleton for the apps/api service (#88a).
//
// Lazy-init pattern: first caller awaits connect(); subsequent
// callers receive the cached connection. The test seam swaps the
// connection out for an in-process server in the L2 itest.
//
// Mirrors the test-seam pattern from packages/auth/src/middleware.ts
// (`_setPoolFactory_TESTING`, `_setVerifier_TESTING`).

import { connect, type NatsConnection } from "nats";

let nc: NatsConnection | null = null;
let pending: Promise<NatsConnection> | null = null;

export async function connectNats(): Promise<NatsConnection> {
  if (nc) return nc;
  if (pending) return pending;
  pending = connect({
    servers: process.env.NATS_URL ?? "nats://nats.nats.svc.cluster.local:4222",
  }).then((c) => {
    nc = c;
    return c;
  });
  return pending;
}

// Test seam — used by unit tests + the L2 itest to inject a pre-wired
// connection (typically against an in-process / hermetic nats-server).
// Pass null to reset to the production lazy-init path.
export function _setNats_TESTING(c: NatsConnection | null): void {
  nc = c;
  pending = c ? Promise.resolve(c) : null;
}
