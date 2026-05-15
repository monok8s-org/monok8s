import type { SecretsAdapter } from "./interface";

// Configuration the operator passes to the factory. `fetch` is
// injectable so tests can stub the HTTP call without touching the
// global; production code passes the default global `fetch`.
export interface VaultConfig {
  endpoint: string; // e.g. "https://vault.svc.cluster.local:8200"
  token: string;
  mount: string;   // Transit engine mount path, e.g. "transit"
  fetch?: typeof fetch;
}

// Vault wraps every response in `{ request_id, data }`. The Transit
// engine returns `ciphertext` / `plaintext` (base64) inside `data`.
interface VaultResponse {
  data?: {
    ciphertext?: string;
    plaintext?: string;
  };
  errors?: string[];
}

const utf8 = new TextDecoder();

const toBase64 = (b: Uint8Array): string =>
  Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");

const fromBase64 = (s: string): Uint8Array =>
  Uint8Array.from(Buffer.from(s, "base64"));

export function newBaremetalAdapter(cfg: VaultConfig): SecretsAdapter {
  const f = cfg.fetch ?? fetch;
  const headers = { "X-Vault-Token": cfg.token, "Content-Type": "application/json" };
  const base = `${cfg.endpoint}/v1/${cfg.mount}`;

  // call wraps the Vault request envelope + error surfacing once.
  const call = async (
    path: string,
    method: "POST" | "DELETE",
    body: object | null,
  ): Promise<VaultResponse> => {
    const res = await f(`${base}/${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Vault returns errors as JSON; fall through to text() if it isn't.
      const raw = await res.text();
      throw new Error(`vault transit ${method} ${path} → ${res.status}: ${raw}`);
    }
    // 204 No Content (e.g. DeleteKey) has no body to parse.
    if (res.status === 204) return {};
    return (await res.json()) as VaultResponse;
  };

  return {
    async mintKey(name: string): Promise<void> {
      await call(`keys/${encodeURIComponent(name)}`, "POST", { type: "aes256-gcm96" });
    },
    async encrypt(name: string, plaintext: Uint8Array): Promise<string> {
      const r = await call(`encrypt/${encodeURIComponent(name)}`, "POST", {
        plaintext: toBase64(plaintext),
      });
      const ct = r.data?.ciphertext;
      if (!ct) throw new Error(`vault transit encrypt ${name}: missing ciphertext`);
      return ct;
    },
    async decrypt(name: string, ciphertext: string): Promise<Uint8Array> {
      const r = await call(`decrypt/${encodeURIComponent(name)}`, "POST", { ciphertext });
      const pt = r.data?.plaintext;
      if (pt == null) throw new Error(`vault transit decrypt ${name}: missing plaintext`);
      return fromBase64(pt);
    },
    async rotateKey(name: string): Promise<void> {
      await call(`keys/${encodeURIComponent(name)}/rotate`, "POST", {});
    },
    async deleteKey(name: string): Promise<void> {
      // Per the crypto-shred design: flip deletion_allowed first,
      // then DELETE. Vault refuses key delete otherwise.
      await call(`keys/${encodeURIComponent(name)}/config`, "POST", {
        deletion_allowed: true,
      });
      await call(`keys/${encodeURIComponent(name)}`, "DELETE", null);
    },
  };
}

// Backwards-compat stub from the #80 scaffolding — throws on call;
// operators wire the real adapter via newBaremetalAdapter(cfg) instead.
const stubMsg = "cloud-adapters/secrets/baremetal: configure via newBaremetalAdapter(cfg)";
export const baremetal: SecretsAdapter = {
  mintKey:   async () => { throw new Error(stubMsg); },
  encrypt:   async () => { throw new Error(stubMsg); },
  decrypt:   async () => { throw new Error(stubMsg); },
  rotateKey: async () => { throw new Error(stubMsg); },
  deleteKey: async () => { throw new Error(stubMsg); },
};

// Suppress unused-import warning when the utf8 decoder isn't needed
// at runtime (kept available for callers that want to lift bytes to
// strings without going back through Buffer themselves).
export const _internal = { utf8 };
