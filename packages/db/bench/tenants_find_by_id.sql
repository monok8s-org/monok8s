-- tenants_find_by_id — bench script for the tenants.findById query shape.
--
-- Mirrors packages/db/src/index.ts::tenants.findById:
--     SELECT * FROM tenants WHERE id = $1
--
-- Run via pgbench. The launcher seeds a tenant with the canonical
-- bench tenant_id (00000000-0000-0000-0000-000000000001) before
-- invoking pgbench, so every iteration hits a real row through the
-- primary-key index path.
--
-- Output: each pgbench client repeats this SELECT for the test's
-- transaction-count budget. Phase A (#166) reports raw latency to
-- stdout; Phase B (follow-up Issue) will capture to
-- TEST_UNDECLARED_OUTPUTS_DIR + add threshold-based regression
-- detection on TPS / per-statement latency.

SELECT * FROM tenants WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;
