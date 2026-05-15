/**
 * @jest-environment node
 *
 * Runtime contract test for the bare-metal CNPG DatabaseAdapter.
 * Hermetic via stubbed fetch — verifies wiring (URL, verb, body, auth)
 * for provision/describe/delete. The Go contract test
 * (//packages/cloud-adapters/database:database_test) does the deeper
 * round-trip via an in-process K8s API fake.
 */
import { describe, beforeEach, it, expect } from "@jest/globals";

import { newBaremetalAdapter } from "./baremetal";

type FetchCall = { url: string; init: { method?: string; body?: string; headers?: Record<string, string> } };

interface FakeFetch {
  (url: string, init?: unknown): Promise<unknown>;
  calls: FetchCall[];
}

const newFakeFetch = (responder: () => { ok?: boolean; status?: number; _body?: unknown }): FakeFetch => {
  const calls: FetchCall[] = [];
  const fn = ((url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ url, init });
    const r = responder();
    return Promise.resolve({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: () => Promise.resolve(r._body ?? {}),
      text: () =>
        Promise.resolve(typeof r._body === "string" ? r._body : JSON.stringify(r._body ?? {})),
    });
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
};

const baseCfg = {
  apiServer: "https://kubernetes.test:6443",
  token: "test-token",
  namespace: "tenant-acme",
};

const clusterCR = (name: string) => ({
  apiVersion: "postgresql.cnpg.io/v1",
  kind: "Cluster",
  metadata: { name, namespace: "tenant-acme" },
  spec: { instances: 1 },
});

describe("cloud-adapters/database/baremetal — runtime wiring contract", () => {
  let f: FakeFetch;

  beforeEach(() => {
    f = newFakeFetch(() => ({ _body: clusterCR("db1") }));
  });

  it("provisionInstance POSTs a CNPG Cluster CR to /apis/postgresql.cnpg.io/v1/namespaces/<ns>/clusters", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    const h = await adapter.provisionInstance("tenant-acme-db", "us-central1");

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(
      "https://kubernetes.test:6443/apis/postgresql.cnpg.io/v1/namespaces/tenant-acme/clusters",
    );
    expect(f.calls[0]!.init.method).toBe("POST");

    const cr = JSON.parse(f.calls[0]!.init.body as string);
    expect(cr.apiVersion).toBe("postgresql.cnpg.io/v1");
    expect(cr.kind).toBe("Cluster");
    expect(cr.metadata).toEqual({ name: "tenant-acme-db", namespace: "tenant-acme" });
    expect(cr.spec.instances).toBe(1);
    expect(cr.spec.bootstrap.initdb.database).toBe("app");

    expect(h.id).toBe("tenant-acme/tenant-acme-db");
    expect(h.dsn).toBe(
      "postgres://app@tenant-acme-db-rw.tenant-acme.svc.cluster.local:5432/app?sslmode=require",
    );
  });

  it("authorization header carries the bearer token", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.provisionInstance("db1", "");
    expect(f.calls[0]!.init.headers!["Authorization"]).toBe("Bearer test-token");
    expect(f.calls[0]!.init.headers!["Content-Type"]).toBe("application/json");
  });

  it("describeInstance GETs /clusters/<name>", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    const h = await adapter.describeInstance("db1");
    expect(f.calls[0]!.url).toBe(
      "https://kubernetes.test:6443/apis/postgresql.cnpg.io/v1/namespaces/tenant-acme/clusters/db1",
    );
    expect(f.calls[0]!.init.method).toBe("GET");
    expect(h.dsn).toBe(
      "postgres://app@db1-rw.tenant-acme.svc.cluster.local:5432/app?sslmode=require",
    );
  });

  it("deleteInstance DELETEs /clusters/<name>", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.deleteInstance("db1");
    expect(f.calls[0]!.init.method).toBe("DELETE");
    expect(f.calls[0]!.url).toBe(
      "https://kubernetes.test:6443/apis/postgresql.cnpg.io/v1/namespaces/tenant-acme/clusters/db1",
    );
  });

  it("non-2xx responses surface as errors", async () => {
    f = newFakeFetch(() => ({ ok: false, status: 404, _body: '{"reason":"NotFound"}' }));
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await expect(adapter.describeInstance("missing")).rejects.toThrow(/404/);
  });

  it("custom database name flows into both the CR and the DSN", async () => {
    const adapter = newBaremetalAdapter({
      ...baseCfg,
      database: "analytics",
      fetch: f as unknown as typeof fetch,
    });
    const h = await adapter.provisionInstance("db1", "");
    const cr = JSON.parse(f.calls[0]!.init.body as string);
    expect(cr.spec.bootstrap.initdb.database).toBe("analytics");
    expect(h.dsn).toContain("/analytics?");
  });
});
