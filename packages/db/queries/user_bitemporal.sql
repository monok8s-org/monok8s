-- =============================================================================
-- Bitemporal query patterns for user_events
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Current state (fast path — use snapshot, not events)
-- -----------------------------------------------------------------------------

SELECT *
FROM   user_snapshots
WHERE  user_id = $1;


-- -----------------------------------------------------------------------------
-- 2. Valid time query
--    "What was true about this user at a point in real-world time?"
--    e.g. "What was Alice's email on Jan 1?"
--    Uses only current transaction knowledge (transaction_to IS NULL).
-- -----------------------------------------------------------------------------

SELECT event_type, event_data, valid_from, valid_to
FROM   user_events
WHERE  user_id          = $1
AND    transaction_to   IS NULL          -- current system knowledge only
AND    valid_from       <= $2            -- $2 = point in valid time
AND   (valid_to         IS NULL OR valid_to > $2)
ORDER  BY event_version;


-- -----------------------------------------------------------------------------
-- 3. Transaction time query
--    "What did our system know about this user at a point in recorded time?"
--    e.g. "What did we know about Alice on Mar 1?" (regardless of when it was true)
-- -----------------------------------------------------------------------------

SELECT event_type, event_data, valid_from, valid_to, transaction_from
FROM   user_events
WHERE  user_id           = $1
AND    transaction_from  <= $2           -- $2 = point in transaction time
AND   (transaction_to    IS NULL OR transaction_to > $2)
ORDER  BY event_version;


-- -----------------------------------------------------------------------------
-- 4. Full bitemporal query
--    "What did we know on transaction_time_point about what was true at valid_time_point?"
--    The most powerful query — used for compliance and audit reconstruction.
-- -----------------------------------------------------------------------------

SELECT event_type, event_data, valid_from, valid_to, transaction_from, transaction_to
FROM   user_events
WHERE  user_id           = $1
AND    valid_from        <= $2           -- $2 = valid time point
AND   (valid_to          IS NULL OR valid_to > $2)
AND    transaction_from  <= $3           -- $3 = transaction time point
AND   (transaction_to    IS NULL OR transaction_to > $3)
ORDER  BY event_version;


-- -----------------------------------------------------------------------------
-- 5. Full event history (all versions, all corrections — nothing hidden)
--    Used for debugging and deep audit. Returns superseded rows too.
-- -----------------------------------------------------------------------------

SELECT event_type, event_data,
       valid_from, valid_to,
       transaction_from, transaction_to,
       CASE WHEN transaction_to IS NULL THEN 'current' ELSE 'superseded' END AS knowledge_status
FROM   user_events
WHERE  user_id = $1
ORDER  BY event_version, transaction_from;


-- -----------------------------------------------------------------------------
-- 6. Retroactive correction pattern
--    Corrects a previously recorded fact without losing the original record.
--    Example: admin corrects a user's email that was entered wrong 3 days ago.
--
--    Step 1: close the superseded event (only permitted UPDATE on user_events)
--    Step 2: insert corrected event with the original valid_from
-- -----------------------------------------------------------------------------

-- Step 1: supersede the incorrect event
UPDATE user_events
SET    transaction_to = now()
WHERE  user_id        = $1
AND    event_version  = $2           -- version being corrected
AND    transaction_to IS NULL;       -- must be current knowledge

-- Step 2: insert corrected event
INSERT INTO user_events (
    tenant_id, user_id,
    event_type, event_version,
    event_data,
    correlation_id, actor_id,
    valid_from,              -- original valid time — not now()
    transaction_from         -- defaults to now() — records when correction was made
) VALUES (
    $3,  -- tenant_id
    $1,  -- user_id
    'user.email_corrected',
    $4,  -- next event_version
    $5,  -- corrected event_data
    $6,  -- correlation_id
    $7,  -- actor_id (admin who made the correction)
    $8   -- original valid_from (when the fact should have been true)
    -- transaction_from defaults to now()
);


-- -----------------------------------------------------------------------------
-- 7. Rebuild snapshot from events
--    Called after appending an event, or to repair a corrupted snapshot.
--    Only processes events with transaction_to IS NULL (current knowledge).
-- -----------------------------------------------------------------------------

INSERT INTO user_snapshots (
    user_id, tenant_id,
    email, display_name, status, zitadel_id,
    as_of_version, created_at, updated_at
)
SELECT
    e.user_id,
    e.tenant_id,
    MAX(e.event_data->>'email')        FILTER (WHERE e.event_type IN ('user.registered','user.email_changed','user.email_corrected')),
    MAX(e.event_data->>'display_name') FILTER (WHERE e.event_type IN ('user.registered','user.display_name_changed')),
    -- status derived from last lifecycle event
    (ARRAY_AGG(
        CASE e.event_type
            WHEN 'user.registered'   THEN 'active'
            WHEN 'user.reactivated'  THEN 'active'
            WHEN 'user.suspended'    THEN 'suspended'
            WHEN 'user.deleted'      THEN 'deleted'
        END
        ORDER BY e.event_version DESC
    ) FILTER (WHERE e.event_type IN ('user.registered','user.suspended','user.reactivated','user.deleted')))[1],
    MAX(e.event_data->>'zitadel_id')   FILTER (WHERE e.event_type = 'user.registered'),
    MAX(e.event_version),
    MIN(e.valid_from),
    now()
FROM  user_events e
WHERE e.user_id        = $1
AND   e.transaction_to IS NULL
GROUP BY e.user_id, e.tenant_id
ON CONFLICT (user_id) DO UPDATE SET
    email          = EXCLUDED.email,
    display_name   = EXCLUDED.display_name,
    status         = EXCLUDED.status,
    as_of_version  = EXCLUDED.as_of_version,
    updated_at     = now();
