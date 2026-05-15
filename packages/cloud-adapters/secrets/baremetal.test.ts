/**
 * @jest-environment node
 *
 * Runtime contract test for the bare-metal Vault Transit SecretsAdapter.
 * Hermetic via a stubbed fetch — the test verifies wiring (each method
 * builds the right URL, method, body shape) rather than running an
 * actual Vault round-trip. The Go contract test (//packages/cloud-
 * adapters/secrets:secrets_test) does the round-trip via an in-process
 * Vault Transit HTTP fake.
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
  endpoint: "http://vault.test:8200",
  token: "fake-token",
  mount: "transit",
};

describe("cloud-adapters/secrets/baremetal — runtime wiring contract", () => {
  let f: FakeFetch;

  beforeEach(() => {
    f = newFakeFetch(() => ({ _body: { data: {} } }));
  });

  it("mintKey POSTs to /v1/<mount>/keys/<name> with type aes256-gcm96", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.mintKey("tenant-acme");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("http://vault.test:8200/v1/transit/keys/tenant-acme");
    expect(f.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ type: "aes256-gcm96" });
    expect(f.calls[0]!.init.headers!["X-Vault-Token"]).toBe("fake-token");
  });

  it("encrypt base64-encodes plaintext and returns ciphertext", async () => {
    f = newFakeFetch(() => ({ _body: { data: { ciphertext: "vault:v1:abc" } } }));
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    const ct = await adapter.encrypt("k1", new TextEncoder().encode("hello"));
    expect(ct).toBe("vault:v1:abc");
    expect(f.calls[0]!.url).toBe("http://vault.test:8200/v1/transit/encrypt/k1");
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body.plaintext).toBe(Buffer.from("hello").toString("base64"));
  });

  it("decrypt base64-decodes plaintext from the response", async () => {
    const b64 = Buffer.from("hello").toString("base64");
    f = newFakeFetch(() => ({ _body: { data: { plaintext: b64 } } }));
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    const pt = await adapter.decrypt("k1", "vault:v1:whatever");
    expect(new TextDecoder().decode(pt)).toBe("hello");
    expect(f.calls[0]!.url).toBe("http://vault.test:8200/v1/transit/decrypt/k1");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ ciphertext: "vault:v1:whatever" });
  });

  it("rotateKey POSTs to /v1/<mount>/keys/<name>/rotate", async () => {
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.rotateKey("k1");
    expect(f.calls[0]!.url).toBe("http://vault.test:8200/v1/transit/keys/k1/rotate");
    expect(f.calls[0]!.init.method).toBe("POST");
  });

  it("deleteKey flips deletion_allowed then DELETEs (crypto-shred semantics)", async () => {
    f = newFakeFetch(() => ({ _body: { data: {} } }));
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await adapter.deleteKey("k1");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toBe("http://vault.test:8200/v1/transit/keys/k1/config");
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ deletion_allowed: true });
    expect(f.calls[1]!.url).toBe("http://vault.test:8200/v1/transit/keys/k1");
    expect(f.calls[1]!.init.method).toBe("DELETE");
  });

  it("non-2xx responses surface as errors", async () => {
    f = newFakeFetch(() => ({ ok: false, status: 403, _body: '{"errors":["permission denied"]}' }));
    const adapter = newBaremetalAdapter({ ...baseCfg, fetch: f as unknown as typeof fetch });
    await expect(adapter.mintKey("k1")).rejects.toThrow(/403/);
  });
});
