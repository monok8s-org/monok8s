// L2 hermetic integration test for makePoolFactory (#85).
//
// Run against rules_pg's pg_server. The bash wrapper creates two
// fresh databases on the instance (tenant_alpha_db, tenant_beta_db);
// this driver constructs a pool factory pointing the SecretFetcher at
// the appropriate database per tenantId, then runs concurrent inserts
// and asserts isolation — alpha's rows must not be visible in beta's
// pool and vice-versa.
//
// Verifies the AC: "L2 pg_test round-trip via two distinct tenant
// pools concurrently".

import assert from "node:assert/strict";

// .js extension required: Node ESM doesn't auto-resolve extensions.
// TypeScript with moduleResolution: "bundler" allows `.js` to refer to
// the `.ts` source at compile time and the `.js` output at runtime.
import { makePoolFactory, type PoolConfig, type SecretFetcher } from "../src/pool.js";

function envOrDie(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env: ${name}`);
  return v;
}

// rules_pg's pg_test launcher exports PGHOST/PGPORT/PGUSER/PGPASSWORD
// (+ PGDATABASE) for the ephemeral instance. The bash wrapper has
// already created the two per-tenant databases on this instance.
const PGHOST = envOrDie("PGHOST");
const PGPORT = Number.parseInt(envOrDie("PGPORT"), 10);
const PGUSER = envOrDie("PGUSER");
const PGPASSWORD = envOrDie("PGPASSWORD");

const tenantDb = (tenantId: string): string => `tenant_${tenantId}_db`;

const fetcher: SecretFetcher = async (tenantId: string): Promise<PoolConfig> => ({
  host: PGHOST,
  port: PGPORT,
  database: tenantDb(tenantId),
  user: PGUSER,
  password: PGPASSWORD,
});

async function main(): Promise<void> {
  const poolFor = makePoolFactory({
    fetchSecret: fetcher,
    maxConnectionsPerPool: 2,
  });

  const alpha = await poolFor("alpha");
  const beta = await poolFor("beta");

  // Sanity: each pool reports a different database.
  const [aDb, bDb] = await Promise.all([
    alpha.query<{ current_database: string }>("SELECT current_database()"),
    beta.query<{ current_database: string }>("SELECT current_database()"),
  ]);
  assert.equal(aDb.rows[0].current_database, "tenant_alpha_db");
  assert.equal(bDb.rows[0].current_database, "tenant_beta_db");

  // Set up an identical table in each tenant database.
  await Promise.all([
    alpha.query("CREATE TABLE IF NOT EXISTS items (id INT PRIMARY KEY, label TEXT)"),
    beta.query("CREATE TABLE IF NOT EXISTS items (id INT PRIMARY KEY, label TEXT)"),
  ]);

  // Concurrent insertions into both pools simultaneously.
  await Promise.all([
    alpha.query("INSERT INTO items (id, label) VALUES (1, 'alpha-1'), (2, 'alpha-2')"),
    beta.query("INSERT INTO items (id, label) VALUES (10, 'beta-10'), (20, 'beta-20')"),
  ]);

  // Isolation: each pool sees only its own rows.
  const [aRows, bRows] = await Promise.all([
    alpha.query<{ id: number; label: string }>("SELECT id, label FROM items ORDER BY id"),
    beta.query<{ id: number; label: string }>("SELECT id, label FROM items ORDER BY id"),
  ]);
  assert.deepEqual(
    aRows.rows.map((r) => r.id),
    [1, 2],
    "alpha pool must see only alpha's rows",
  );
  assert.deepEqual(
    bRows.rows.map((r) => r.id),
    [10, 20],
    "beta pool must see only beta's rows",
  );
  assert.deepEqual(
    aRows.rows.map((r) => r.label),
    ["alpha-1", "alpha-2"],
  );
  assert.deepEqual(
    bRows.rows.map((r) => r.label),
    ["beta-10", "beta-20"],
  );

  // Cache property: repeated calls for same tenantId return same Pool
  // instance, and the underlying pg connection works.
  const alphaAgain = await poolFor("alpha");
  assert.equal(alphaAgain, alpha, "cached Pool instance must be reused");
  const r = await alphaAgain.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM items",
  );
  assert.equal(r.rows[0].count, "2");

  // Clean shutdown.
  await Promise.all([alpha.end(), beta.end()]);

  // eslint-disable-next-line no-console
  console.log("pool_l2_test: ok");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
