-- pg_partman setup for event tables.
--
-- Run this when an event table approaches 80GB (EventTableApproaching100GB alert).
-- Partitioning by valid_from (monthly) allows old partitions to be detached
-- and moved to cheaper storage without affecting live queries.
--
-- Prerequisite: pg_partman and pg_cron extensions must be installed.
-- CloudNativePG supports both via the postgresql.conf extensions list.

-- ── Enable extensions ─────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_partman;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── Partition user_events ──────────────────────────────────────────────────────
-- Simplification: pg_partman auto-creates future partitions and manages retention.
-- Manual partition SQL is never needed after this runs once.

SELECT partman.create_parent(
    p_parent_table  := 'public.user_events',
    p_control       := 'valid_from',
    p_type          := 'range',
    p_interval      := 'monthly',
    p_premake       := 3            -- pre-create 3 future months
);

UPDATE partman.part_config
SET    retention                 = '7 years',
       retention_keep_table      = true,    -- detach, don't drop (compliance)
       infinite_time_partitions  = true,
       automatic_maintenance     = 'on'
WHERE  parent_table = 'public.user_events';

-- ── Schedule maintenance ───────────────────────────────────────────────────────
-- Runs every hour: creates upcoming partitions, detaches expired ones.
-- Simplification: this replaces all manual partition management with a single cron.

SELECT cron.schedule(
    'partman-maintenance',
    '0 * * * *',
    $$SELECT partman.run_maintenance(p_analyze := false)$$
);

-- ── Verify partition structure ─────────────────────────────────────────────────
-- SELECT tablename, pg_size_pretty(pg_total_relation_size(tablename::regclass))
-- FROM   pg_tables
-- WHERE  tablename LIKE 'user_events_%'
-- ORDER  BY tablename;
