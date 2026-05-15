-- Migration 006: marketplace metering records, access review decisions,
--                 security finding incidents

-- ── Marketplace ───────────────────────────────────────────────────────────────

-- Tracks pending and submitted usage records for cloud marketplace billing.
-- Records are written by CollectMeteringDataActivity before submission and
-- updated by the cloud-specific submit activities.
CREATE TABLE marketplace_usage_records (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid NOT NULL REFERENCES tenants(id),
    source              text NOT NULL CHECK (source IN ('aws_marketplace','gcp_marketplace','azure_marketplace')),
    dimension_name      text NOT NULL,
    quantity            bigint NOT NULL CHECK (quantity >= 0),
    period_start        timestamptz NOT NULL,
    period_end          timestamptz NOT NULL,
    idempotency_key     text NOT NULL UNIQUE,  -- "<tenant_id>:<period_end_unix>"
    status              text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','submitted','failed')),
    external_record_id  text,           -- cloud-assigned record ID after submission
    submitted_at        timestamptz,
    created_at          timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX marketplace_usage_records_tenant ON marketplace_usage_records (tenant_id);
CREATE INDEX marketplace_usage_records_status ON marketplace_usage_records (status) WHERE status != 'submitted';

-- Extend tenants table with marketplace metadata
ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS marketplace_source        text
        CHECK (marketplace_source IN ('aws_marketplace','gcp_marketplace','azure_marketplace')),
    ADD COLUMN IF NOT EXISTS marketplace_customer_id   text,
    ADD COLUMN IF NOT EXISTS marketplace_plan          text;

CREATE INDEX tenants_marketplace_source ON tenants (marketplace_source) WHERE marketplace_source IS NOT NULL;

-- ── Access review ─────────────────────────────────────────────────────────────

-- Records the outcome of each periodic access recertification.
CREATE TABLE access_review_decisions (
    review_id       text NOT NULL,
    assignment_id   uuid NOT NULL,
    tenant_id       uuid NOT NULL REFERENCES tenants(id),
    user_id         uuid NOT NULL,
    role            text NOT NULL,
    decision        text NOT NULL CHECK (decision IN ('confirmed','revoked','auto_revoked')),
    reviewed_at     timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    PRIMARY KEY (review_id, assignment_id)
);

CREATE INDEX access_review_decisions_tenant ON access_review_decisions (tenant_id);
CREATE INDEX access_review_decisions_reviewed_at ON access_review_decisions (reviewed_at);

-- Track when each membership was last reviewed so stale assignments can be found.
ALTER TABLE tenant_memberships
    ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz;

CREATE INDEX tenant_memberships_last_reviewed ON tenant_memberships (last_reviewed_at)
    WHERE last_reviewed_at IS NOT NULL;

-- ── Security findings ─────────────────────────────────────────────────────────

-- Persists cloud security findings (Security Hub, Defender, SCC) for the ops
-- dashboard. tenant_id is NULL for orphaned findings (resource has no tenant tag).
CREATE TABLE security_finding_incidents (
    finding_id      text PRIMARY KEY,           -- cloud-native finding ID (for dedup)
    cloud           text NOT NULL CHECK (cloud IN ('aws','azure','gcp')),
    tenant_id       uuid REFERENCES tenants(id), -- nullable for orphaned findings
    resource_type   text,
    resource_id     text,
    resource_arn    text,
    severity        text NOT NULL CHECK (severity IN ('critical','high','medium','low','informational')),
    title           text NOT NULL,
    description     text,
    finding_type    text NOT NULL,
    status          text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','resolved','suppressed','orphaned')),
    raw_payload     text,
    received_at     timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    updated_at      timestamptz
);

CREATE INDEX security_finding_incidents_tenant ON security_finding_incidents (tenant_id)
    WHERE tenant_id IS NOT NULL;
CREATE INDEX security_finding_incidents_status ON security_finding_incidents (status)
    WHERE status = 'active';
CREATE INDEX security_finding_incidents_severity ON security_finding_incidents (severity, created_at DESC);
