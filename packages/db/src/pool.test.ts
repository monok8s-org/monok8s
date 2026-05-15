// L1 unit tests for the per-tenant pool factory (#85).
//
// Uses pure dependency injection — both the SecretFetcher and the
// PoolCtor are stubs. No real pg or jest.mock("pg") needed; no
// internal Jest module-reset paths invoked. Covers LRU eviction,
// idle timeout, concurrent first-access race coalescing, and
// defensive pool.end() handling.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";

import {
  makePoolFactory,
  type PoolConfig,
  type PoolCtor,
  type SecretFetcher,
} from "./pool.js";

const cfg = (tenantId: string): PoolConfig => ({
  host: `${tenantId}.host`,
  port: 5432,
  database: `${tenantId}_db`,
  user: tenantId,
  password: "secret",
});

const noFlake = (): jest.MockedFunction<SecretFetcher> =>
  jest.fn<SecretFetcher>(async (t: string) => cfg(t));

// Lightweight Pool stub. Each .end() call is observed via the
// per-instance mock; we don't track which one was called when there
// are multiple — instead each test inspects mocked ends as a group.
type FakePool = { end: jest.MockedFunction<() => Promise<void>> };
const stubPools: FakePool[] = [];
const makeStubCtor = (): jest.MockedFunction<PoolCtor> => {
  stubPools.length = 0;
  return jest.fn<PoolCtor>(() => {
    const p: FakePool = { end: jest.fn(async () => undefined) };
    stubPools.push(p);
    return p as unknown as Pool;
  });
};

afterEach(() => {
  stubPools.length = 0;
});

describe("makePoolFactory", () => {
  test("loads pool on first access", async () => {
    const fetchSecret = noFlake();
    const poolCtor = makeStubCtor();
    const poolFor = makePoolFactory({ fetchSecret, poolCtor });

    const p = await poolFor("alpha");

    expect(p).toBeDefined();
    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(fetchSecret).toHaveBeenCalledWith("alpha");
    expect(poolCtor).toHaveBeenCalledTimes(1);
  });

  test("caches pool across calls for same tenant", async () => {
    const fetchSecret = noFlake();
    const poolCtor = makeStubCtor();
    const poolFor = makePoolFactory({ fetchSecret, poolCtor });

    const p1 = await poolFor("alpha");
    const p2 = await poolFor("alpha");
    const p3 = await poolFor("alpha");

    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    expect(fetchSecret).toHaveBeenCalledTimes(1);
    expect(poolCtor).toHaveBeenCalledTimes(1);
  });

  test("evicts oldest when cache size exceeded", async () => {
    const fetchSecret = noFlake();
    const poolCtor = makeStubCtor();
    const poolFor = makePoolFactory({ fetchSecret, poolCtor, cacheSize: 2 });

    const pa = await poolFor("alpha");
    const pb = await poolFor("beta");
    // Force a third entry — should evict alpha (the oldest).
    await poolFor("gamma");

    // alpha's pool had .end() called; beta + gamma still live.
    expect(stubPools[0].end).toHaveBeenCalledTimes(1);
    expect(stubPools[1].end).not.toHaveBeenCalled();
    expect(stubPools[2].end).not.toHaveBeenCalled();

    // beta is still in the cache (gamma's add evicted only alpha).
    const pbCachedHit = await poolFor("beta");
    expect(pbCachedHit).toBe(pb);
    expect(fetchSecret).toHaveBeenCalledTimes(3);

    // Re-resolving alpha now requires a fresh fetch + new Pool — and
    // adding it evicts the now-oldest entry (which is gamma since beta
    // got bumped to MRU above). cache state was [gamma, beta] → loading
    // alpha makes it [beta, alpha] and evicts gamma.
    const paAgain = await poolFor("alpha");
    expect(paAgain).not.toBe(pa);
    expect(fetchSecret).toHaveBeenCalledTimes(4);
    expect(stubPools[2].end).toHaveBeenCalledTimes(1);
  });

  test("LRU recency bumps on re-access", async () => {
    const fetchSecret = noFlake();
    const poolCtor = makeStubCtor();
    const poolFor = makePoolFactory({ fetchSecret, poolCtor, cacheSize: 2 });

    await poolFor("alpha");
    await poolFor("beta");
    // Re-access alpha — move to MRU.
    await poolFor("alpha");
    // Adding gamma should now evict beta (oldest after alpha's bump).
    await poolFor("gamma");

    // beta (stubPools[1]) was evicted; alpha (stubPools[0]) was retained.
    expect(stubPools[0].end).not.toHaveBeenCalled();
    expect(stubPools[1].end).toHaveBeenCalledTimes(1);

    fetchSecret.mockClear();
    await poolFor("alpha");
    await poolFor("gamma");
    expect(fetchSecret).not.toHaveBeenCalled();
    await poolFor("beta");
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  test("evicts on idle timeout", async () => {
    jest.useFakeTimers();
    try {
      const fetchSecret = noFlake();
      const poolCtor = makeStubCtor();
      const poolFor = makePoolFactory({
        fetchSecret,
        poolCtor,
        idleTimeoutMs: 5_000,
      });

      await poolFor("alpha");
      expect(poolCtor).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(5_001);
      // Eviction is async — flush microtasks.
      await Promise.resolve();
      await Promise.resolve();

      expect(stubPools[0].end).toHaveBeenCalledTimes(1);

      // Re-access requires a fresh Pool.
      await poolFor("alpha");
      expect(poolCtor).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("idle timer resets on cache hit", async () => {
    jest.useFakeTimers();
    try {
      const fetchSecret = noFlake();
      const poolCtor = makeStubCtor();
      const poolFor = makePoolFactory({
        fetchSecret,
        poolCtor,
        idleTimeoutMs: 5_000,
      });

      await poolFor("alpha");

      jest.advanceTimersByTime(4_000);
      await poolFor("alpha");

      jest.advanceTimersByTime(4_000);
      await Promise.resolve();
      expect(stubPools[0].end).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1_001);
      await Promise.resolve();
      await Promise.resolve();
      expect(stubPools[0].end).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("concurrent first-access returns same Pool (no double-init)", async () => {
    let release!: (cfg: PoolConfig) => void;
    const slow = new Promise<PoolConfig>((resolve) => {
      release = resolve;
    });
    const fetchSecret = jest.fn<SecretFetcher>(async (t: string) => {
      if (t === "alpha") return slow;
      return cfg(t);
    });
    const poolCtor = makeStubCtor();
    const poolFor = makePoolFactory({ fetchSecret, poolCtor });

    const [p1Promise, p2Promise, p3Promise] = [
      poolFor("alpha"),
      poolFor("alpha"),
      poolFor("alpha"),
    ];
    expect(fetchSecret).toHaveBeenCalledTimes(1);

    release(cfg("alpha"));
    const [p1, p2, p3] = await Promise.all([p1Promise, p2Promise, p3Promise]);

    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    expect(poolCtor).toHaveBeenCalledTimes(1);
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  test("eviction is defensive when pool.end() rejects", async () => {
    const fetchSecret = noFlake();
    const poolCtor: jest.MockedFunction<PoolCtor> = jest.fn<PoolCtor>(() => {
      // Each new pool's .end() throws. Eviction must absorb cleanly.
      const p: FakePool = {
        end: jest.fn(async () => {
          throw new Error("end failed");
        }),
      };
      stubPools.push(p);
      return p as unknown as Pool;
    });
    const poolFor = makePoolFactory({
      fetchSecret,
      poolCtor,
      cacheSize: 1,
    });

    await poolFor("alpha");
    // Triggers eviction of alpha — should not reject.
    await expect(poolFor("beta")).resolves.toBeDefined();
    expect(stubPools[0].end).toHaveBeenCalledTimes(1);
  });
});
