-- =============================================================================
-- Service accounts and API keys
--
-- Service accounts are non-human principals — CI/CD runners, integrations,
-- internal workers. They authenticate via API key, not Zitadel JWT.
--
-- Authorization is handled identically to users: SpiceDB tenant relations.
-- Service accounts can hold any tenant role except owner.
--
-- Key design decisions:
--   - token_hash (SHA-256) only — raw key shown once at creation, never stored
--   - key_prefix stored for display ("sk_live_a3f2...") — not a secret
--   - expires_at: NULL = non-expiring (for long-lived internal SAs)
--   - Temporal workflow ID stored for expiry timer cleanup (temporary grants)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Service accounts
-- -----------------------------------------------------------------------------

CREATE TABLE service_accounts (

    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name             TEXT        NOT NULL,
    description      TEXT,

    -- SpiceDB object ID for this SA (= id cast to text, stored for clarity)
    spicedb_id       TEXT        NOT NULL UNIQUE,

    status           TEXT        NOT NULL DEFAULT 'active'
                                 CHECK (status IN ('active', 'suspended', 'deleted')),

    created_by       UUID        NOT NULL,   -- user_id of creator
    deleted_at       TIMESTAMPTZ,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sa_tenant_idx        ON service_accounts (tenant_id)        WHERE deleted_at IS NULL;
CREATE INDEX sa_tenant_status_idx ON service_accounts (tenant_id, status) WHERE deleted_at IS NULL;

ALTER TABLE service_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sa_tenant_isolation ON service_accounts
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE service_accounts;

-- -----------------------------------------------------------------------------
-- API keys
--
-- One service account can have multiple active keys (rotation support).
-- Raw key is shown exactly once at creation and never stored.
-- Format of the raw key: "sk_<env>_<32 random hex chars>"
--   e.g. "sk_live_a3f2b1c8..." — prefix "sk_live_a3f2" stored in key_prefix
-- -----------------------------------------------------------------------------

CREATE TABLE api_keys (

    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    service_account_id  UUID        NOT NULL REFERENCES service_accounts(id) ON DELETE CASCADE,
    tenant_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name                TEXT,                       -- human-readable label

    -- Token storage — SHA-256 of the raw key
    token_hash          TEXT        NOT NULL UNIQUE,
    -- First 12 chars of raw key for display in UI ("sk_live_a3f2...")
    key_prefix          TEXT        NOT NULL,

    -- IP allowlist for this key — NULL = unrestricted
    -- Written as SpiceDB caveat context: ip_allowlist{"allowed_ips": [...]}
    -- Store here for UI display and re-hydrating caveat context on auth
    allowed_ips         TEXT[],

    expires_at          TIMESTAMPTZ,                -- NULL = non-expiring
    last_used_at        TIMESTAMPTZ,
    revoked_at          TIMESTAMPTZ,
    revoked_by          UUID,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_sa_idx     ON api_keys (service_account_id) WHERE revoked_at IS NULL;
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id)          WHERE revoked_at IS NULL;
-- Partial index for expiry sweeps (Temporal timer or background job)
CREATE INDEX api_keys_expiry_idx ON api_keys (expires_at)
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_tenant_isolation ON api_keys
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE api_keys;

-- -----------------------------------------------------------------------------
-- Temporary grants
--
-- Records JIT/time-bounded role elevations — belt-and-suspenders alongside
-- SpiceDB expiry caveats. The caveat makes the SpiceDB relation inert after
-- expiry_at without cleanup; this table drives the Temporal timer that
-- removes the relation and provides an audit trail.
--
-- Workflow:
--   1. writeTemporaryGrant() writes SpiceDB relation with expiry caveat
--   2. INSERT here with temporal_workflow_id
--   3. Temporal TemporaryGrantWorkflow fires at expiry_at
--   4. deleteTemporaryGrant() removes the SpiceDB relation
--   5. UPDATE status = 'expired' here
-- -----------------------------------------------------------------------------

CREATE TABLE temporary_grants (

    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    subject_id           UUID        NOT NULL,
    subject_type         TEXT        NOT NULL CHECK (subject_type IN ('user', 'service_account')),
    role                 TEXT        NOT NULL,     -- TenantRole (not owner)

    granted_by           UUID        NOT NULL,
    reason               TEXT,                    -- audit: why was this granted

    expires_at           TIMESTAMPTZ NOT NULL,
    status               TEXT        NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active', 'expired', 'revoked')),
    revoked_by           UUID,
    revoked_at           TIMESTAMPTZ,

    temporal_workflow_id TEXT,                    -- for cancellation on early revoke

    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tmp_grants_tenant_idx   ON temporary_grants (tenant_id, status);
CREATE INDEX tmp_grants_subject_idx  ON temporary_grants (subject_id, tenant_id) WHERE status = 'active';
CREATE INDEX tmp_grants_expiry_idx   ON temporary_grants (expires_at) WHERE status = 'active';

ALTER TABLE temporary_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tmp_grants_tenant_isolation ON temporary_grants
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE temporary_grants;
