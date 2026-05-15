-- Migration 008: audit_log table for mutation-procedure audit trail
--
-- Append-only audit log written by the tRPC auditMiddleware (packages/auth)
-- on every mutation procedure that opts in via the `auditedMutation` helper.
--
-- Two consumers today:
--   1. tRPC events.audit subscription (live SSE tail per tenant, #179)
--   2. Future audit query/list reads (out of scope for #179)
--
-- Design notes:
--   - No FK to tenants(id). Audit records must outlive tenant deletion;
--     compliance regimes (SOC 2, ISO 27001) require audit retention beyond
--     subject lifetime. tenant_id is denormalized for RLS scoping.
--   - principal_id is similarly free of FK. Principals (users, service
--     accounts) can be deleted but their audit trail must persist.
--   - metadata is JSONB to allow per-action structured detail without
--     migrations for new event types; queryable via JSONB operators.
--   - outcome is intentionally binary (success/error). Finer-grained states
--     (e.g. "partial-success") add audit ambiguity; mutations either land
--     or they don't.
--   - Indexes target the two known read shapes: time-range per tenant
--     (live tail + history scroll) and per-principal audit trail
--     (subject-rights requests, security investigations).

CREATE TABLE audit_log (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Tenant scoping (RLS — no FK; see design notes above)
    tenant_id       UUID        NOT NULL,

    -- Acting principal (no FK — see design notes above)
    principal_id    UUID        NOT NULL,
    principal_type  TEXT        NOT NULL
                                CHECK (principal_type IN ('user', 'service_account')),

    -- Action semantics
    action          TEXT        NOT NULL,        -- e.g. "audit.ping", "tenant.create"
    target_kind     TEXT        NOT NULL,        -- e.g. "tenant", "installation"
    target_id       TEXT,                        -- NULL when target ID isn't applicable (e.g. create-style)

    -- Outcome
    outcome         TEXT        NOT NULL
                                CHECK (outcome IN ('success', 'error')),
    error_message   TEXT,                        -- populated when outcome = 'error'

    -- Free-form per-action structured detail
    metadata        JSONB,

    -- Standard timestamp
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Time-range queries per tenant (live tail + history)
CREATE INDEX audit_log_tenant_created_at_idx
    ON audit_log (tenant_id, created_at DESC);

-- Per-principal audit trail
CREATE INDEX audit_log_tenant_principal_idx
    ON audit_log (tenant_id, principal_id, created_at DESC);

-- Per-action drilldown (e.g. "show every 'tenant.create' attempt")
CREATE INDEX audit_log_tenant_action_idx
    ON audit_log (tenant_id, action, created_at DESC);

-- RLS: cross-tenant isolation
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant_isolation ON audit_log
    USING (tenant_id = current_setting('app.tenant_id')::uuid);

-- Down (if rollback needed):
-- DROP TABLE audit_log;
