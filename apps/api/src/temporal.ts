// Temporal Client singleton for the apps/api service (#222).
//
// Lazy-init pattern: first caller awaits getTemporalClient(); subsequent
// callers receive the cached WorkflowClient. The test seam swaps the
// client out for a stub in unit tests; an L2 itest would point at an
// in-process Temporal dev server.
//
// Mirrors apps/api/src/nats.ts. Module-level singleton because the
// Temporal Client holds a long-lived gRPC connection that's process-wide,
// not per-request or per-tenant. Tenant scoping lives in the workflowId
// convention (`tnt-<tenant>-<action>-<id>`), not in separate Client
// instances.
//
// Surface intentionally narrow — apps/api needs only the WorkflowClient
// (`client.workflow`), not the full Client. WorkflowClient carries the
// `start` + `getHandle` methods that mutation procedures call to kick
// off and observe workflows. Schedule / async-completion / counter ops
// stay in apps/workers.

import { Client, Connection, type WorkflowClient } from "@temporalio/client";

let client: WorkflowClient | null = null;
let pending: Promise<WorkflowClient> | null = null;

export interface ResolvedTemporalConfig {
  address: string;
  namespace: string;
}

// Pure config-read helper so unit tests can verify env-var parsing
// without touching the Temporal Client construction path. Defaults
// match the in-cluster Temporal service (platform/temporal/* manifests).
export function resolveTemporalConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTemporalConfig {
  return {
    address: env.TEMPORAL_HOST ?? "temporal.temporal.svc.cluster.local:7233",
    namespace: env.TEMPORAL_NAMESPACE ?? "default",
  };
}

export async function getTemporalClient(): Promise<WorkflowClient> {
  if (client) return client;
  if (pending) return pending;
  const config = resolveTemporalConfig();
  pending = (async () => {
    // Connection.lazy defers the actual gRPC dial until the first
    // workflow op fires — keeps process startup decoupled from the
    // Temporal service being up.
    const connection = Connection.lazy({ address: config.address });
    const full = new Client({ connection, namespace: config.namespace });
    client = full.workflow;
    return client;
  })();
  return pending;
}

// Test seam — used by unit tests + (future) L2 itests to inject a
// stubbed WorkflowClient or one pointed at a hermetic Temporal dev
// server. Pass null to reset to the production lazy-init path.
export function _setTemporalClient_TESTING(
  c: WorkflowClient | null,
): void {
  client = c;
  pending = c ? Promise.resolve(c) : null;
}
