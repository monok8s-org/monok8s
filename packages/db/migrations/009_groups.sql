-- Migration 009: groups table for tenant-scoped principal grouping
--
-- Groups are tenant-scoped, nestable, and hold tenant roles transitively
-- per packages/auth/schema.zed: `role:<r> = ... | group#membership`. The
-- `owner` role is the one exception that cannot be assigned to a group
-- (enforced at the SpiceDB-write helper layer, not in this schema).
--
-- Design notes:
--   - tenant_id FK to tenants(id) ON DELETE CASCADE: when a tenant is
--     deleted, its groups go with it (unlike audit_log which must
--     outlive deletion). RLS keys on the same `app.tenant_id` GUC the
--     rest of the principal tables use.
--   - parent_group_id self-FK ON DELETE SET NULL: a deleted parent
--     leaves child groups intact at the root level rather than
--     cascading the delete. Application code can re-parent later.
--   - (tenant_id, name) unique: per-tenant name collisions are blocked
--     at the schema level. SpiceDB resolves group:<id> via the row's
--     id (UUID PK), not name, so renames don't break relations.
--   - No state column. Group membership / role assignment lives in
--     SpiceDB; this table holds only the structural metadata.

CREATE TABLE groups (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    parent_group_id UUID        REFERENCES groups(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Per-tenant name uniqueness; SpiceDB relations still resolve by id.
    UNIQUE (tenant_id, name)
);

-- Tenant scans (list groups in tenant)
CREATE INDEX groups_tenant_idx ON groups (tenant_id);

-- Parent-child traversal (find children of a group, walk to root)
CREATE INDEX groups_parent_idx ON groups (parent_group_id)
    WHERE parent_group_id IS NOT NULL;

-- RLS: cross-tenant isolation, same pattern as the rest of the
-- principal tables in 001/002.
ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY groups_tenant_isolation ON groups
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE groups;
