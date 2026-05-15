// K8s API Secret reader for per-tenant Postgres connection details (#85).
//
// Production SecretFetcher implementation for pool.ts. Reads the CNPG-
// emitted `<cluster>-app` Secret from the tenant-<id> namespace and
// returns the PoolConfig consumed by pg.Pool.
//
// Pattern mirrors packages/cloud-adapters/database/baremetal.ts:
// bare fetch + bearer token + JSON body. No K8s SDK dependency.
//
// We never cache the Secret bytes — only the resulting pg.Pool object
// (in pool.ts's LRU). When a tenant's Secret is rotated, the next cache
// miss after eviction picks up the new credentials.

import type { PoolConfig, SecretFetcher } from "./pool.js";

interface K8sSecret {
  apiVersion?: "v1";
  kind?: "Secret";
  metadata?: { name?: string; namespace?: string };
  data?: Record<string, string>; // base64-encoded values
}

export interface K8sConfig {
  apiServer: string;
  token: string;
  fetch?: typeof fetch;
}

// CNPG names the connection Secret `<cluster>-app`. The tenant-database-
// cnpg Composition (per #82) names clusters as `<tenantId>-db1`, so the
// Secret resolves to `<tenantId>-db1-app` in namespace `tenant-<tenantId>`.
const SECRET_NAME_FORMAT = (tenantId: string): string => `${tenantId}-db1-app`;
const NAMESPACE_FORMAT = (tenantId: string): string => `tenant-${tenantId}`;

export function makeK8sSecretFetcher(cfg: K8sConfig): SecretFetcher {
  const f = cfg.fetch ?? fetch;

  return async function fetchSecret(tenantId: string): Promise<PoolConfig> {
    const ns = NAMESPACE_FORMAT(tenantId);
    const name = SECRET_NAME_FORMAT(tenantId);
    const url = `${cfg.apiServer}/api/v1/namespaces/${encodeURIComponent(ns)}/secrets/${encodeURIComponent(name)}`;
    const res = await f(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`k8s api GET ${url} → ${res.status}: ${body}`);
    }
    const secret = (await res.json()) as K8sSecret;
    const data = secret.data;
    if (!data) {
      throw new Error(`k8s Secret ${ns}/${name} has no data field`);
    }
    return {
      host: decode(data, "host", ns, name),
      port: Number.parseInt(decode(data, "port", ns, name), 10),
      database: decode(data, "dbname", ns, name),
      user: decode(data, "username", ns, name),
      password: decode(data, "password", ns, name),
    };
  };
}

function decode(
  data: Record<string, string>,
  key: string,
  ns: string,
  name: string,
): string {
  const v = data[key];
  if (v == null) {
    throw new Error(`k8s Secret ${ns}/${name} missing key '${key}'`);
  }
  return Buffer.from(v, "base64").toString("utf8");
}

// defaultK8sConfig reads the apiServer + token from the standard
// in-cluster ServiceAccount mount path. Used by apps/api at startup
// when running in-cluster; tests and dev paths inject a fake
// SecretFetcher instead.
export function defaultK8sConfig(): K8sConfig {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT;
  if (!host || !port) {
    throw new Error(
      "defaultK8sConfig: KUBERNETES_SERVICE_HOST/PORT not set — not running in-cluster?",
    );
  }
  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  // Synchronous read — apps/api calls this once at startup before
  // the event loop starts spinning, so the small blocking read is
  // acceptable and matches k8s client-go's convention.
  // Note: callers should construct the K8sConfig once, not per-request.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("node:fs") as typeof import("node:fs");
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  return { apiServer: `https://${host}:${port}`, token };
}
