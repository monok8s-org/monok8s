-- Migration 007: cloud resource inventory table
--
-- The `cloud_resources` table is the source for:
--   - `monok8s tenant resources` command (list cloud resources per tenant)
--   - `monok8s drift check` (compare against SpiceDB)
--   - Security finding tenant resolution (fall back to ARN lookup)
--
-- Populated by a Crossplane composition event watcher (or by periodic sync
-- via the API's /tenants/:id/resources endpoint which reads Crossplane
-- composite resource status). Kept in sync by the onboarding workflow.

CREATE TABLE cloud_resources (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    cloud           text NOT NULL CHECK (cloud IN ('gcp', 'aws', 'azure')),
    resource_type   text NOT NULL,  -- monok8s.io/resource-type tag value
    resource_arn    text NOT NULL,  -- cloud-native identifier (ARN/resource name/resource ID)
    resource_name   text NOT NULL,  -- human-readable name
    status          text NOT NULL DEFAULT 'synced'
                        CHECK (status IN ('synced', 'diverged', 'pending', 'error')),
    -- Crossplane desired state (from XR spec)
    desired         jsonb,
    -- Cloud actual state (from last cloud API poll)
    actual          jsonb,
    -- Last time the resource was reconciled by Crossplane
    last_synced_at  timestamptz,
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    updated_at      timestamptz NOT NULL DEFAULT NOW(),
    UNIQUE (cloud, resource_arn)
);

CREATE INDEX cloud_resources_tenant ON cloud_resources (tenant_id);
CREATE INDEX cloud_resources_status ON cloud_resources (status) WHERE status != 'synced';
CREATE INDEX cloud_resources_arn    ON cloud_resources (resource_arn);

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION update_cloud_resources_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER cloud_resources_updated_at
    BEFORE UPDATE ON cloud_resources
    FOR EACH ROW EXECUTE FUNCTION update_cloud_resources_updated_at();

-- Drift summary view — used by `monok8s drift check`
CREATE VIEW cloud_resource_drift AS
SELECT
    cr.tenant_id,
    cr.cloud,
    cr.resource_type,
    cr.resource_arn,
    cr.resource_name,
    cr.status,
    cr.last_synced_at,
    t.name AS tenant_name
FROM cloud_resources cr
JOIN tenants t ON t.id = cr.tenant_id
WHERE cr.status IN ('diverged', 'error');
