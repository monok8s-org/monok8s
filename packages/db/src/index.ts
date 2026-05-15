// packages/db public surface.
//
// Per #85 there is no singleton pool. The tRPC auth middleware (in #89)
// resolves the per-tenant pool via `makePoolFactory(...)` from `./pool`
// and stores the resulting `Pool` on the request context. Query helpers
// take that pool as their first argument — there's no module-level
// mutable state, and no path by which a caller can resolve the wrong
// tenant's pool without going through middleware validation.

import type { Pool, QueryResult, QueryResultRow } from "pg";

export { Pool } from "pg";
export {
  makePoolFactory,
  type PoolConfig,
  type PoolDeps,
  type SecretFetcher,
} from "./pool.js";
export { makeK8sSecretFetcher, defaultK8sConfig, type K8sConfig } from "./k8s.js";

export interface Tenant {
  id: string;
  slug: string;
  plan: string;
  created_at: Date;
}

export interface User {
  id: string;
  tenant_id: string;
  zitadel_id: string;
  email: string;
  created_at: Date;
}

export interface Group {
  id: string;
  tenant_id: string;
  name: string;
  parent_group_id: string | null;
  created_at: Date;
}

const one = <T extends QueryResultRow>(r: QueryResult<T>): T | null =>
  r.rows[0] ?? null;

export const tenants = {
  async list(pool: Pool): Promise<Tenant[]> {
    const r = await pool.query<Tenant>(
      "SELECT * FROM tenants ORDER BY created_at",
    );
    return r.rows;
  },

  async findById(pool: Pool, id: string): Promise<Tenant | null> {
    const r = await pool.query<Tenant>("SELECT * FROM tenants WHERE id = $1", [
      id,
    ]);
    return one(r);
  },

  async findBySlug(pool: Pool, slug: string): Promise<Tenant | null> {
    const r = await pool.query<Tenant>(
      "SELECT * FROM tenants WHERE slug = $1",
      [slug],
    );
    return one(r);
  },

  async create(
    pool: Pool,
    input: { slug: string; plan?: string },
  ): Promise<Tenant> {
    const r = await pool.query<Tenant>(
      "INSERT INTO tenants (slug, plan) VALUES ($1, COALESCE($2, 'starter')) RETURNING *",
      [input.slug, input.plan ?? null],
    );
    const row = one(r);
    if (!row) throw new Error("tenants.create: insert returned no row");
    return row;
  },
};

export const users = {
  async findById(pool: Pool, id: string): Promise<User | null> {
    const r = await pool.query<User>("SELECT * FROM users WHERE id = $1", [id]);
    return one(r);
  },

  async findByZitadelId(
    pool: Pool,
    zitadelId: string,
  ): Promise<User | null> {
    const r = await pool.query<User>(
      "SELECT * FROM users WHERE zitadel_id = $1",
      [zitadelId],
    );
    return one(r);
  },

  async findByTenant(pool: Pool, tenantId: string): Promise<User[]> {
    const r = await pool.query<User>(
      "SELECT * FROM users WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    return r.rows;
  },

  async create(
    pool: Pool,
    input: { tenant_id: string; zitadel_id: string; email: string },
  ): Promise<User> {
    const r = await pool.query<User>(
      "INSERT INTO users (tenant_id, zitadel_id, email) VALUES ($1, $2, $3) RETURNING *",
      [input.tenant_id, input.zitadel_id, input.email],
    );
    const row = one(r);
    if (!row) throw new Error("users.create: insert returned no row");
    return row;
  },
};

// Groups — tenant-scoped, nestable, hold tenant roles transitively
// per packages/auth/schema.zed (#87b / #174 / migration 009). The
// `owner` role exception is enforced at the SpiceDB-write helper
// layer, not in these read/write helpers.
export const groups = {
  async list(pool: Pool, tenantId: string): Promise<Group[]> {
    const r = await pool.query<Group>(
      "SELECT * FROM groups WHERE tenant_id = $1 ORDER BY created_at",
      [tenantId],
    );
    return r.rows;
  },

  async findById(pool: Pool, id: string): Promise<Group | null> {
    const r = await pool.query<Group>(
      "SELECT * FROM groups WHERE id = $1",
      [id],
    );
    return one(r);
  },

  async findByTenant(pool: Pool, tenantId: string): Promise<Group[]> {
    // Alias for `list`; kept for parity with users.findByTenant naming
    // (caller intent is the same; this name reads better at use sites
    // that explicitly want tenant-scoped iteration).
    return groups.list(pool, tenantId);
  },

  async create(
    pool: Pool,
    input: { tenant_id: string; name: string; parent_group_id?: string | null },
  ): Promise<Group> {
    const r = await pool.query<Group>(
      "INSERT INTO groups (tenant_id, name, parent_group_id) VALUES ($1, $2, $3) RETURNING *",
      [input.tenant_id, input.name, input.parent_group_id ?? null],
    );
    const row = one(r);
    if (!row) throw new Error("groups.create: insert returned no row");
    return row;
  },

  // PATCH-style update. Only the fields present in `input` change; the
  // builder skips absent keys via $-param indexing on the included
  // fields only. `parent_group_id: null` is a legitimate value (move
  // the group to top-level) — null vs undefined matters here.
  async update(
    pool: Pool,
    id: string,
    input: { name?: string; parent_group_id?: string | null },
  ): Promise<Group | null> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      params.push(input.name);
      sets.push(`name = $${params.length}`);
    }
    if (input.parent_group_id !== undefined) {
      params.push(input.parent_group_id);
      sets.push(`parent_group_id = $${params.length}`);
    }
    if (sets.length === 0) {
      throw new Error(
        "groups.update: at least one of name / parent_group_id must be provided",
      );
    }
    params.push(id);
    const r = await pool.query<Group>(
      `UPDATE groups SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    return one(r);
  },

  // Returns { id } on success, null if the row was missing.
  async delete(pool: Pool, id: string): Promise<{ id: string } | null> {
    const r = await pool.query<{ id: string }>(
      "DELETE FROM groups WHERE id = $1 RETURNING id",
      [id],
    );
    return one(r);
  },
};

// ── temporary_grants (migration 004; #224 + #226 + #228 / first-ui grants surface) ──
//
// JIT-elevation row. INSERT happens inside the TemporaryGrantWorkflow
// activity, not via this package — the helpers below are READ-only.
// Status lifecycle: 'active' (created) → 'expired' (timer fired) /
// 'revoked' (signal received). Both terminal states have their
// revoked_at OR expires_at as the timestamp of effect.

export interface TemporaryGrant {
  id: string;
  tenant_id: string;
  subject_id: string;
  subject_type: "user" | "service_account";
  role: string;
  granted_by: string;
  reason: string | null;
  expires_at: Date;
  status: "active" | "expired" | "revoked";
  revoked_by: string | null;
  revoked_at: Date | null;
  temporal_workflow_id: string | null;
  created_at: Date;
}

export const temporary_grants = {
  async list(pool: Pool, tenantId: string): Promise<TemporaryGrant[]> {
    const r = await pool.query<TemporaryGrant>(
      "SELECT * FROM temporary_grants WHERE tenant_id = $1 ORDER BY created_at DESC",
      [tenantId],
    );
    return r.rows;
  },

  async findById(pool: Pool, id: string): Promise<TemporaryGrant | null> {
    const r = await pool.query<TemporaryGrant>(
      "SELECT * FROM temporary_grants WHERE id = $1",
      [id],
    );
    return one(r);
  },

  // updateReason — patches just the audit `reason` field on an
  // in-flight grant. Pure DB write, no SpiceDB / Temporal involvement
  // (reason is an operator-facing audit string, not a relation
  // property). Returns the updated row OR null when missing.
  async updateReason(
    pool: Pool,
    id: string,
    reason: string | null,
  ): Promise<TemporaryGrant | null> {
    const r = await pool.query<TemporaryGrant>(
      "UPDATE temporary_grants SET reason = $1 WHERE id = $2 RETURNING *",
      [reason, id],
    );
    return one(r);
  },
};

// ── audit_log (migration 008; #208 / #88c sibling) ──────────────────────────
//
// Read-side helper for the audit_log table. RLS scopes the rows to the
// caller's tenant via current_setting('app.tenant_id'), which
// tenantProcedure's per-tenant Pool already sets at request time —
// callers don't pass tenant_id; they pass the per-tenant Pool that
// carries the setting.
//
// Indexes from migration 008:
//   - (tenant_id, created_at DESC)          — time-range
//   - (tenant_id, principal_id, created_at) — per-principal
//   - (tenant_id, action, created_at)       — per-action

export interface AuditLog {
  id: string;
  tenant_id: string;
  principal_id: string;
  principal_type: "user" | "service_account";
  action: string;
  target_kind: string;
  target_id: string | null;
  outcome: "success" | "error";
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export interface AuditListFilters {
  action?: string;
  principalId?: string;
  // ISO-8601 cursor for next-page navigation. The query uses
  // `created_at < $before` so subsequent pages pass the oldest seen
  // created_at from the prior batch.
  before?: string;
  // Defaults to 50 at call site (caller responsible — the input
  // parser clamps from the wire); this helper trusts the value it
  // receives.
  limit?: number;
}

export const audit = {
  async list(
    pool: Pool,
    filters: AuditListFilters = {},
  ): Promise<AuditLog[]> {
    // Each filter is optional; omitted ones reduce to `NULL IS NULL`
    // which the planner folds out via constant propagation. The
    // explicit ::text / ::uuid / ::timestamptz casts let pg type the
    // bound parameter even when the application sends raw null —
    // without them, pg can't infer the column type from a bare
    // `$N IS NULL` and rejects the statement.
    //
    // Parameterized throughout — no string interpolation into SQL per
    // packages/db CLAUDE.md.
    const r = await pool.query<AuditLog>(
      `SELECT * FROM audit_log
       WHERE ($1::text IS NULL OR action = $1)
         AND ($2::uuid IS NULL OR principal_id = $2)
         AND ($3::timestamptz IS NULL OR created_at < $3)
       ORDER BY created_at DESC
       LIMIT $4`,
      [
        filters.action ?? null,
        filters.principalId ?? null,
        filters.before ?? null,
        filters.limit ?? 50,
      ],
    );
    return r.rows;
  },
};
