-- =============================================================================
-- User principal: event-sourced + bitemporal
--
-- Two tables:
--   user_events    append-only event store with both time axes
--   user_snapshots current-state projection for O(1) reads
--
-- Time axes:
--   valid_from / valid_to       when the fact was true in the real world
--   transaction_from / to       when our system recorded the fact
--
-- The only permitted UPDATE is setting transaction_to = now() when correcting
-- a previously recorded event. Event data (event_type, event_data) is immutable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Event store
-- -----------------------------------------------------------------------------

CREATE TABLE user_events (

    -- Identity
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id          UUID        NOT NULL,

    -- Event envelope
    event_type       TEXT        NOT NULL,
    event_version    BIGINT      NOT NULL,   -- monotonic sequence per user_id
    event_data       JSONB       NOT NULL,

    -- Causality
    caused_by        UUID        REFERENCES user_events(id),  -- parent event
    correlation_id   UUID        NOT NULL,   -- Temporal workflow / request trace ID
    actor_id         UUID,                   -- who triggered this; NULL = system

    -- Valid time — when was this fact true in the real world?
    valid_from       TIMESTAMPTZ NOT NULL,
    valid_to         TIMESTAMPTZ,            -- NULL = still valid

    -- Transaction time — when did our system record this fact?
    -- transaction_from: set once on INSERT, never changed
    -- transaction_to:   NULL = current knowledge; set to now() on correction only
    transaction_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    transaction_to   TIMESTAMPTZ,            -- NULL = current system knowledge

    -- Constraints
    CONSTRAINT valid_time_order       CHECK (valid_to       IS NULL OR valid_to       > valid_from),
    CONSTRAINT transaction_time_order CHECK (transaction_to IS NULL OR transaction_to > transaction_from),
    CONSTRAINT event_version_positive CHECK (event_version > 0)
);

-- One version per user within current transaction knowledge
CREATE UNIQUE INDEX user_events_version_current_idx
    ON user_events (user_id, event_version)
    WHERE transaction_to IS NULL;

-- Bitemporal range queries
CREATE INDEX user_events_valid_time_idx
    ON user_events (user_id, valid_from, valid_to)
    WHERE transaction_to IS NULL;

CREATE INDEX user_events_transaction_time_idx
    ON user_events (user_id, transaction_from, transaction_to);

-- Tenant scans
CREATE INDEX user_events_tenant_idx
    ON user_events (tenant_id, user_id);

-- Correlation / causality traversal
CREATE INDEX user_events_correlation_idx
    ON user_events (correlation_id);

-- RLS: tenants cannot see each other's events
ALTER TABLE user_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_events_tenant_isolation ON user_events
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- -----------------------------------------------------------------------------
-- Snapshot (current-state projection)
-- Rebuilt by replaying events. Never written to directly by application code.
-- -----------------------------------------------------------------------------

CREATE TABLE user_snapshots (

    user_id          UUID        PRIMARY KEY,
    tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Projected state (derived from events — do not write here directly)
    email            TEXT        NOT NULL,
    display_name     TEXT,
    status           TEXT        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'suspended', 'deleted')),
    zitadel_id       TEXT        UNIQUE,     -- external identity provider reference

    -- Snapshot provenance
    as_of_version    BIGINT      NOT NULL,   -- last event_version included in this snapshot
    snapshot_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Standard columns
    created_at       TIMESTAMPTZ NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX user_snapshots_tenant_idx ON user_snapshots (tenant_id);
CREATE INDEX user_snapshots_email_idx  ON user_snapshots (tenant_id, email);

ALTER TABLE user_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_snapshots_tenant_isolation ON user_snapshots
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- -----------------------------------------------------------------------------
-- Known event types (registry — enforced at application layer, documented here)
--
--   user.registered          initial creation
--   user.email_changed       user changed their own email
--   user.email_corrected     admin corrected an email data error (retroactive)
--   user.display_name_changed
--   user.suspended           access revoked by admin
--   user.reactivated         suspension lifted
--   user.deleted             soft delete
--   user.role_assigned       SpiceDB relation written; recorded here for audit
--   user.role_revoked
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- PII store (GDPR-separated)
--
-- Encrypted at rest via Vault Transit. The app calls Vault to encrypt before
-- INSERT and decrypt on SELECT — the plaintext never touches Postgres storage.
-- Crypto-shredding on erasure: delete the Vault Transit key for the user;
-- the ciphertext becomes permanently unreadable without any data deletion.
--
-- email uniqueness: per-tenant (same email can appear in multiple tenants).
-- Global uniqueness is enforced by Zitadel (identity provider).
-- -----------------------------------------------------------------------------

CREATE TABLE user_pii (

    user_id          UUID        PRIMARY KEY REFERENCES user_snapshots(user_id) ON DELETE CASCADE,
    tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Vault Transit ciphertext. Format: "vault:v<version>:<base64>"
    -- Key path: transit/keys/user-<user_id>
    email_ciphertext TEXT        NOT NULL,
    phone_ciphertext TEXT,
    full_name_ciphertext TEXT,

    -- Vault key version at time of last encryption (for re-wrap tracking)
    key_version      INT         NOT NULL DEFAULT 1,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-tenant uniqueness enforced at app layer via this index on ciphertext
-- (ciphertext of same plaintext under same key version is deterministic with
-- convergent encryption — enable convergent_encryption on the Transit key).
CREATE UNIQUE INDEX user_pii_email_tenant_idx ON user_pii (tenant_id, email_ciphertext);

ALTER TABLE user_pii ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_pii_tenant_isolation ON user_pii
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE user_pii;

-- -----------------------------------------------------------------------------
-- Tenant membership events
--
-- Separate event stream from user_events: different retention, different audit
-- consumers, and membership state is multi-dimensional (one user × N tenants).
--
-- SpiceDB is the authoritative source for *current* permissions.
-- This table is the authoritative audit log for *how* membership changed.
-- The `roles` column is intentionally absent — SpiceDB owns role state.
-- -----------------------------------------------------------------------------

CREATE TABLE tenant_membership_events (

    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id          UUID        NOT NULL,

    event_type       TEXT        NOT NULL,
    -- Known values:
    --   membership.invited          invitation sent
    --   membership.invite_accepted  user clicked link, pending → active
    --   membership.invite_expired   Temporal timeout fired
    --   membership.invite_revoked   admin cancelled before acceptance
    --   membership.role_changed     SpiceDB write recorded here for audit
    --   membership.suspended        access revoked
    --   membership.reactivated      suspension lifted
    --   membership.removed          member removed from tenant
    event_data       JSONB       NOT NULL DEFAULT '{}',

    -- Causality
    correlation_id   UUID        NOT NULL,
    actor_id         UUID,                   -- NULL = system/Temporal

    -- Transaction time only (membership events are not retroactively correctable)
    transaction_from TIMESTAMPTZ NOT NULL DEFAULT now(),

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tmevents_tenant_user_idx    ON tenant_membership_events (tenant_id, user_id);
CREATE INDEX tmevents_correlation_idx    ON tenant_membership_events (correlation_id);
CREATE INDEX tmevents_transaction_idx    ON tenant_membership_events (transaction_from);

ALTER TABLE tenant_membership_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tmevents_tenant_isolation ON tenant_membership_events
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE tenant_membership_events;

-- -----------------------------------------------------------------------------
-- Invitations
--
-- Token: SHA-256 hash of the raw JWT sent in the email link.
-- Verify by: SHA-256(presented_token) = token_hash.
-- Raw token is never stored — a DB breach does not expose invitation credentials.
--
-- Expiry: `expires_at` column. Temporal activity enforces timeout via
-- scheduleToClose; a workflow timer fires writeMembershipExpired if not accepted.
-- No pg_cron polling needed.
--
-- State machine (enforced at app layer):
--   pending → accepted  (invite_accepted event)
--   pending → expired   (Temporal timer)
--   pending → revoked   (admin action)
-- -----------------------------------------------------------------------------

CREATE TABLE invitations (

    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Invitee identity (pre-registration — user_id may not exist yet)
    invitee_email    TEXT        NOT NULL,
    invitee_user_id  UUID,       -- populated on acceptance if user already exists

    -- Role to be granted in SpiceDB on acceptance
    intended_role    TEXT        NOT NULL
                                 CHECK (intended_role IN ('admin','member','viewer','billing_manager')),

    -- Token: SHA-256 hash of the JWT sent in the invitation email
    -- Never store the raw token
    token_hash       TEXT        NOT NULL UNIQUE,

    status           TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','accepted','expired','revoked')),

    invited_by       UUID        NOT NULL,   -- actor_id of inviting user
    expires_at       TIMESTAMPTZ NOT NULL,
    accepted_at      TIMESTAMPTZ,
    revoked_at       TIMESTAMPTZ,

    -- Temporal workflow managing the expiry timer
    temporal_workflow_id TEXT,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invitations_tenant_idx      ON invitations (tenant_id, status);
CREATE INDEX invitations_invitee_email_idx ON invitations (tenant_id, invitee_email)
    WHERE status = 'pending';
CREATE INDEX invitations_expires_at_idx  ON invitations (expires_at)
    WHERE status = 'pending';

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant_isolation ON invitations
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE invitations;

-- -----------------------------------------------------------------------------
-- Profile resolution view
--
-- Resolves the effective display profile for a user within a tenant.
-- Tenant-specific overrides (stored in user_snapshots) coalesce over
-- the global PII record. RLS on the underlying tables provides isolation.
--
-- NOTE: email is decrypted by the application after fetching; the view
-- exposes only the ciphertext — never attempt to decrypt in SQL.
-- -----------------------------------------------------------------------------

CREATE VIEW user_profile AS
SELECT
    s.user_id,
    s.tenant_id,
    s.display_name,
    s.status,
    s.zitadel_id,
    p.email_ciphertext,
    p.phone_ciphertext,
    p.full_name_ciphertext,
    p.key_version,
    s.created_at,
    s.updated_at
FROM user_snapshots s
LEFT JOIN user_pii p ON p.user_id = s.user_id;

-- Down (if rollback needed):
-- DROP VIEW user_profile;
