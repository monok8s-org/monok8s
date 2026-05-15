/**
 * @jest-environment node
 *
 * Runtime contract test for the bare-metal OTLP ObservabilityAdapter.
 * Hermetic via stubbed fetch — verifies each push method builds the
 * right OTLP/HTTP/JSON envelope and POSTs to the right signal endpoint.
 */
import { describe, beforeEach, it, expect } from "@jest/globals";

import { newBaremetalAdapter } from "./baremetal";

type FetchCall = { url: string; init: { method?: string; body?: string; headers?: Record<string, string> } };

interface FakeFetch {
  (url: string, init?: unknown): Promise<unknown>;
  calls: FetchCall[];
}

const newFakeFetch = (): FakeFetch => {
  const calls: FetchCall[] = [];
  const fn = ((url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
  }) as FakeFetch;
  fn.calls = calls;
  return fn;
};

const baseCfg = {
  logsURL: "https://loki.test/otlp/v1/logs",
  metricsURL: "https://mimir.test/otlp/v1/metrics",
  tracesURL: "https://tempo.test/otlp/v1/traces",
  serviceName: "monok8s-test",
};

describe("cloud-adapters/observability/baremetal — runtime wiring contract", () => {
  let f: FakeFetch;

  beforeEach(() => {
    f = newFakeFetch();
  });

  it("pushLogs POSTs OTLP envelope to logsURL", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.pushLogs([
      { timestamp: 1700000000000000000, severity: "INFO", body: "hello", labels: { tenant_id: "acme" } },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(baseCfg.logsURL);
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(f.calls[0]!.init.headers!["Content-Type"]).toBe("application/json");

    const payload = JSON.parse(f.calls[0]!.init.body as string);
    const rec = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(rec.timeUnixNano).toBe("1700000000000000000");
    expect(rec.severityText).toBe("INFO");
    expect(rec.body.stringValue).toBe("hello");
    expect(rec.attributes[0]).toEqual({ key: "tenant_id", value: { stringValue: "acme" } });
  });

  it("pushMetrics POSTs gauge dataPoints to metricsURL", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.pushMetrics([
      { name: "tenant.users.active", value: 42, timestamp: 1700000000000000000, labels: { tenant_id: "acme" } },
    ]);
    expect(f.calls[0]!.url).toBe(baseCfg.metricsURL);
    const payload = JSON.parse(f.calls[0]!.init.body as string);
    const m = payload.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(m.name).toBe("tenant.users.active");
    expect(m.gauge.dataPoints[0].asDouble).toBe(42);
  });

  it("pushTraces POSTs spans to tracesURL", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.pushTraces([{
      traceId: "abc",
      spanId: "def",
      name: "create-tenant",
      startTimeNs: 1700000000000000000,
      endTimeNs: 1700000001000000000,
      attributes: { tenant_id: "acme" },
    }]);
    expect(f.calls[0]!.url).toBe(baseCfg.tracesURL);
    const span = JSON.parse(f.calls[0]!.init.body as string)
      .resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe("abc");
    expect(span.spanId).toBe("def");
    expect(span.name).toBe("create-tenant");
  });

  it("empty batches are no-ops (no fetch calls)", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.pushLogs([]);
    await adapter.pushMetrics([]);
    await adapter.pushTraces([]);
    expect(f.calls).toHaveLength(0);
  });

  it("auth header propagates when configured", async () => {
    const adapter = newBaremetalAdapter({
      ...baseCfg,
      authHeader: "Basic dGVuYW50LWFjbWU6cGFzc3dvcmQ=",
      fetch: f as unknown as typeof fetch,
    });
    await adapter.pushLogs([{ timestamp: 1, severity: "INFO", body: "x", labels: {} }]);
    expect(f.calls[0]!.init.headers!["Authorization"]).toBe("Basic dGVuYW50LWFjbWU6cGFzc3dvcmQ=");
  });

  it("non-2xx responses surface as errors", async () => {
    f = ((url: string, init: { headers?: Record<string, string> } = {}) => {
      void url;
      void init;
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve("upstream down") });
    }) as unknown as FakeFetch;
    f.calls = [];
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await expect(
      adapter.pushLogs([{ timestamp: 1, severity: "INFO", body: "x", labels: {} }]),
    ).rejects.toThrow(/503/);
  });
});
