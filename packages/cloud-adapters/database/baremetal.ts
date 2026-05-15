import type { DatabaseAdapter, DatabaseHandle } from "./interface";

// Configuration the operator passes to the factory. `fetch` is
// injectable for tests; production code passes the default global.
export interface CnpgConfig {
  apiServer: string;       // e.g. "https://kubernetes.default.svc"
  token: string;
  namespace: string;
  database?: string;       // database CNPG seeds; default "app"
  fetch?: typeof fetch;
}

interface CnpgCluster {
  apiVersion: "postgresql.cnpg.io/v1";
  kind: "Cluster";
  metadata: { name: string; namespace: string };
  spec: object;
  status?: object;
}

const CLUSTERS = "/apis/postgresql.cnpg.io/v1/namespaces";

export function newBaremetalAdapter(cfg: CnpgConfig): DatabaseAdapter {
  const f = cfg.fetch ?? fetch;
  const database = cfg.database ?? "app";
  const headers = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${cfg.token}`,
    ...extra,
  });

  const url = (name?: string) =>
    name == null
      ? `${cfg.apiServer}${CLUSTERS}/${cfg.namespace}/clusters`
      : `${cfg.apiServer}${CLUSTERS}/${cfg.namespace}/clusters/${encodeURIComponent(name)}`;

  const buildHandle = (name: string): DatabaseHandle => ({
    id: `${cfg.namespace}/${name}`,
    dsn: `postgres://app@${name}-rw.${cfg.namespace}.svc.cluster.local:5432/${database}?sslmode=require`,
  });

  const surface = async (res: Response, method: string, target: string): Promise<unknown> => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`k8s api ${method} ${target} → ${res.status}: ${body}`);
    }
    if (res.status === 204) return null;
    return res.json();
  };

  return {
    async provisionInstance(name: string, _region: string): Promise<DatabaseHandle> {
      const cr: CnpgCluster = {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        metadata: { name, namespace: cfg.namespace },
        spec: {
          instances: 1,
          bootstrap: { initdb: { database, owner: "app" } },
        },
      };
      const res = await f(url(), {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(cr),
      });
      await surface(res, "POST", url());
      return buildHandle(name);
    },
    async describeInstance(name: string): Promise<DatabaseHandle> {
      const res = await f(url(name), { method: "GET", headers: headers() });
      await surface(res, "GET", url(name));
      return buildHandle(name);
    },
    async deleteInstance(name: string): Promise<void> {
      const res = await f(url(name), { method: "DELETE", headers: headers() });
      await surface(res, "DELETE", url(name));
    },
  };
}

// Backwards-compat stub from the #80 scaffolding — throws on call;
// operators wire the real adapter via newBaremetalAdapter(cfg) instead.
const stubMsg = "cloud-adapters/database/baremetal: configure via newBaremetalAdapter(cfg)";
export const baremetal: DatabaseAdapter = {
  provisionInstance: async () => { throw new Error(stubMsg); },
  describeInstance:  async () => { throw new Error(stubMsg); },
  deleteInstance:    async () => { throw new Error(stubMsg); },
};
