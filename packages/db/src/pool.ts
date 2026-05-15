// Per-tenant Postgres connection pool factory (#85).
//
// Replaces the prior singleton `pool` export with a per-tenant lazy
// factory + LRU cache. The auth middleware (in #89) resolves exactly
// one effective tenantId per request, calls this factory, and stores
// the resulting Pool in `ctx.db`. Query helpers in index.ts take the
// pool as their first argument — there's no module-level mutable
// state, and no path by which a caller can resolve the wrong tenant's
// pool without going through middleware validation.
//
// Cache eviction is LRU + idle-timeout. Defaults err on the security
// side (smaller cache, shorter timeout) and are operator-tunable via
// MONOK8S_POOL_CACHE_SIZE + MONOK8S_POOL_IDLE_TIMEOUT_MS env vars.
// On eviction the underlying pg.Pool is `.end()`-ed cleanly to release
// connections.
//
// Concurrent first-access for the same tenantId returns the same Pool
// instance — the in-flight Promise is cached separately from the
// resolved entry so racing callers await the same resolution.

import { Pool } from "pg";

export interface PoolConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// SecretFetcher resolves the per-tenant Postgres connection details.
// Production: reads the K8s Secret `<cluster>-app` from the
// `tenant-<tenantId>` namespace (see k8s.ts).
// Tests: a stub returning hardcoded configs keyed by tenantId.
export type SecretFetcher = (tenantId: string) => Promise<PoolConfig>;

// PoolCtor abstracts pg.Pool construction for tests — production passes
// the real `new Pool(...)`, tests inject a stub returning a minimal
// `{ end(): Promise<void> }` shape. Avoids global jest.mock("pg") which
// triggers internal Jest resetModules paths.
export type PoolCtor = (cfg: PoolConfig & { max: number }) => Pool;

export interface PoolDeps {
  fetchSecret: SecretFetcher;
  cacheSize?: number;
  idleTimeoutMs?: number;
  maxConnectionsPerPool?: number;
  poolCtor?: PoolCtor;
}

interface CacheEntry {
  pool: Pool;
  idleTimer: NodeJS.Timeout | null;
}

const DEFAULT_CACHE_SIZE =
  Number.parseInt(process.env.MONOK8S_POOL_CACHE_SIZE ?? "", 10) || 16;
const DEFAULT_IDLE_TIMEOUT_MS =
  Number.parseInt(process.env.MONOK8S_POOL_IDLE_TIMEOUT_MS ?? "", 10) || 300_000;

// Per-pool connection ceiling. With default cache size 16 this caps
// total connections at 80 — safely under Postgres's default
// max_connections=100. Operators can override via the factory deps.
const DEFAULT_MAX_CONNECTIONS = 5;

export function makePoolFactory(
  deps: PoolDeps,
): (tenantId: string) => Promise<Pool> {
  const fetchSecret = deps.fetchSecret;
  const cacheSize = deps.cacheSize ?? DEFAULT_CACHE_SIZE;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxConns = deps.maxConnectionsPerPool ?? DEFAULT_MAX_CONNECTIONS;
  const poolCtor: PoolCtor = deps.poolCtor ?? ((cfg) => new Pool(cfg));

  // Map insertion order is the LRU recency order: the oldest entry is
  // the first key, the most-recently-used is the last. On access we
  // delete + re-insert to move to the tail.
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<Pool>>();

  function scheduleIdleEviction(tenantId: string): NodeJS.Timeout {
    const t = setTimeout(() => {
      void evict(tenantId);
    }, idleTimeoutMs);
    // Don't keep the Node event loop alive solely on a pending eviction.
    t.unref();
    return t;
  }

  async function evict(tenantId: string): Promise<void> {
    const entry = cache.get(tenantId);
    if (!entry) return;
    cache.delete(tenantId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      await entry.pool.end();
    } catch {
      // Defensive: pool.end() failures shouldn't block eviction —
      // the cache entry is already removed and the underlying pool
      // will be garbage-collected when no in-flight queries hold it.
    }
  }

  async function load(tenantId: string): Promise<Pool> {
    const cfg = await fetchSecret(tenantId);
    return poolCtor({ ...cfg, max: maxConns });
  }

  return async function poolForTenant(tenantId: string): Promise<Pool> {
    const cached = cache.get(tenantId);
    if (cached) {
      if (cached.idleTimer) clearTimeout(cached.idleTimer);
      cached.idleTimer = scheduleIdleEviction(tenantId);
      cache.delete(tenantId);
      cache.set(tenantId, cached);
      return cached.pool;
    }

    let p = inflight.get(tenantId);
    if (p) return p;

    p = (async (): Promise<Pool> => {
      try {
        const pool = await load(tenantId);
        while (cache.size >= cacheSize) {
          const oldestKey = cache.keys().next().value;
          if (oldestKey == null) break;
          await evict(oldestKey);
        }
        cache.set(tenantId, {
          pool,
          idleTimer: scheduleIdleEviction(tenantId),
        });
        return pool;
      } finally {
        inflight.delete(tenantId);
      }
    })();
    inflight.set(tenantId, p);
    return p;
  };
}
