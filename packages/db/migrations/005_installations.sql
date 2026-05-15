-- =============================================================================
-- Model B installations
--
-- An installation is a self-hosted Model B deployment belonging to a tenant.
-- Model A receives telemetry, alerts, and heartbeats from registered installs.
--
-- Identity model:
--   cert_serial / cert_expires_at  — mTLS client cert issued by Vault PKI
--                                    (for OTel telemetry, rotated every 24h)
--   api_key_hash                   — SHA-256 of API key for alerts + heartbeats
--                                    (longer-lived, rotatable by tenant admin)
--
-- Registration flow:
--   1. Tenant admin creates a pending install record → receives bootstrap_token
--   2. Model B CLI exchanges bootstrap_token for a cert + API key
--      (InstallationRegistrationWorkflow in Temporal)
--   3. bootstrap_token_hash is NULLed after first use (one-time)
--   4. status → active, HeartbeatMonitorWorkflow starts
-- =============================================================================

CREATE TABLE installations (

    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name                  TEXT        NOT NULL,
    description           TEXT,

    -- SpiceDB object ID (= id cast to text)
    spicedb_id            TEXT        NOT NULL UNIQUE,

    -- mTLS client certificate (issued by Vault PKI, auto-rotated on Model B)
    cert_serial           TEXT,
    cert_expires_at       TIMESTAMPTZ,

    -- API key for alert webhook + heartbeat endpoint (rotatable)
    -- Raw key shown once at activation, never stored
    api_key_hash          TEXT        UNIQUE,    -- SHA-256
    api_key_prefix        TEXT,                  -- first 8 chars for display
    api_key_rotated_at    TIMESTAMPTZ,

    -- One-time bootstrap token used during registration handshake
    bootstrap_token_hash  TEXT        UNIQUE,    -- SHA-256; NULLed after use
    bootstrap_token_expires_at TIMESTAMPTZ,

    -- Heartbeat state
    last_heartbeat_at     TIMESTAMPTZ,
    heartbeat_status      TEXT        NOT NULL DEFAULT 'never_seen'
                                      CHECK (heartbeat_status IN
                                        ('healthy', 'warning', 'critical', 'never_seen')),
    -- Temporal workflow managing heartbeat monitoring (for signalling)
    heartbeat_workflow_id TEXT,

    -- Self-reported host metadata (sent at registration + on each heartbeat)
    host_cloud            TEXT        CHECK (host_cloud IN
                                        ('gcp', 'aws', 'azure', 'bare-metal', 'other')),
    host_region           TEXT,
    k8s_version           TEXT,
    model_b_version       TEXT,       -- semver of the installed monok8s release

    -- Lifecycle
    status                TEXT        NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending', 'active', 'revoked')),
    registered_by         UUID        NOT NULL,  -- user_id of tenant admin who initiated
    revoked_at            TIMESTAMPTZ,
    revoked_by            UUID,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX installations_tenant_idx        ON installations (tenant_id)        WHERE status != 'revoked';
CREATE INDEX installations_status_idx        ON installations (tenant_id, status);
CREATE INDEX installations_heartbeat_idx     ON installations (heartbeat_status)  WHERE status = 'active';
-- Used by the cert rotation check job
CREATE INDEX installations_cert_expiry_idx   ON installations (cert_expires_at)   WHERE status = 'active';

-- installations are visible to the owning tenant only (via RLS)
-- and to platform admins (bypasses RLS via BYPASSRLS role on the platform SA)
ALTER TABLE installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY installations_tenant_isolation ON installations
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE installations;
