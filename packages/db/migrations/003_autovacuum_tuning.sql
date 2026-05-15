-- Autovacuum tuning for append-heavy and correction-heavy tables.
--
-- Default autovacuum triggers at 20% dead tuples (autovacuum_vacuum_scale_factor = 0.2).
-- For large event tables, 20% of 10M rows = 2M dead tuples before cleanup runs.
-- These settings trigger at 1% instead, keeping bloat bounded.
--
-- Run after 002_user_principal.sql. Add equivalent ALTER TABLE statements
-- here for every new *_events table added to the schema.

-- User events — bitemporal corrections create dead tuples
ALTER TABLE user_events SET (
    autovacuum_vacuum_scale_factor   = 0.01,
    autovacuum_vacuum_threshold      = 1000,
    autovacuum_vacuum_cost_delay     = 2,
    autovacuum_analyze_scale_factor  = 0.005
);

-- User snapshots — updated on every event append
ALTER TABLE user_snapshots SET (
    autovacuum_vacuum_scale_factor   = 0.02,
    autovacuum_vacuum_threshold      = 500,
    autovacuum_vacuum_cost_delay     = 2
);

-- Tenant memberships — updated when roles change
ALTER TABLE tenant_memberships SET (
    autovacuum_vacuum_scale_factor   = 0.02,
    autovacuum_vacuum_threshold      = 500
);

-- Invitations — status transitions create dead tuples
ALTER TABLE invitations SET (
    autovacuum_vacuum_scale_factor   = 0.05,
    autovacuum_vacuum_threshold      = 100
);

-- Verify settings applied correctly:
-- SELECT relname, reloptions FROM pg_class WHERE relname LIKE '%_events';
