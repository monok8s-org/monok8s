#!/usr/bin/env bash
# packages/db/test/schema_test.sh
#
# L2 hermetic test: rules_pg's pg_test launcher initdb's an ephemeral
# Postgres cluster, applies every migration in :schema's srcs, then execs
# this script with PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD set.
# This script asserts the migrations landed the expected schema shape:
#
#   - `tenants` and `users` tables exist
#   - `users.tenant_id` is a NOT NULL FK to `tenants(id)` ON DELETE CASCADE
#   - `users_tenant_id_idx` index exists on `users.tenant_id`
#   - one round-trip insert into both tables works (FK semantics live)
#
# Pure shape + minimal-behavior assertion. RLS policies are documented in
# packages/db/CLAUDE.md but no migration applies them yet — they're owned
# by a follow-up Issue once apps/api wiring lands.

set -euo pipefail

require_env() {
    local var="$1"
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var not set — pg_test launcher should have set it" >&2
        exit 1
    fi
}
require_env PGHOST
require_env PGPORT
require_env PGDATABASE
require_env PGUSER
require_env PGPASSWORD

psql() {
    PGPASSWORD="$PGPASSWORD" command psql \
        -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
        --no-password -v ON_ERROR_STOP=1 -t -A "$@"
}

echo "--- schema_test: connecting to $PGDATABASE on $PGHOST:$PGPORT ---"

assert_table() {
    local table="$1"
    local count
    count=$(psql -c "SELECT COUNT(*) FROM information_schema.tables
                     WHERE table_schema='public' AND table_name='$table';")
    if [[ "$count" != "1" ]]; then
        echo "FAIL: table '$table' not found" >&2
        exit 1
    fi
    echo "OK: table '$table' exists"
}

assert_table tenants
assert_table users
assert_table groups

# Foreign-key shape: users.tenant_id -> tenants(id), ON DELETE CASCADE,
# NOT NULL. Read constraint metadata directly so we don't depend on \d output.
fk_check=$(psql -c "
    SELECT conname || ' ' || confdeltype::text FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'f'
      AND confrelid = 'tenants'::regclass;")
if [[ -z "$fk_check" ]]; then
    echo "FAIL: users → tenants foreign key not found" >&2
    exit 1
fi
if [[ "$fk_check" != *" c" ]]; then
    echo "FAIL: users → tenants foreign key not ON DELETE CASCADE (got: '$fk_check')" >&2
    exit 1
fi
echo "OK: users.tenant_id FK to tenants(id) ON DELETE CASCADE present"

nullable=$(psql -c "
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='tenant_id';")
if [[ "$nullable" != "NO" ]]; then
    echo "FAIL: users.tenant_id should be NOT NULL (got: '$nullable')" >&2
    exit 1
fi
echo "OK: users.tenant_id is NOT NULL"

idx=$(psql -c "
    SELECT indexname FROM pg_indexes
    WHERE schemaname='public' AND tablename='users' AND indexname='users_tenant_id_idx';")
if [[ "$idx" != "users_tenant_id_idx" ]]; then
    echo "FAIL: index 'users_tenant_id_idx' not found" >&2
    exit 1
fi
echo "OK: index 'users_tenant_id_idx' present"

# Round-trip insert exercises the live FK + the gen_random_uuid() default
# (built into PG 13+ as part of contrib).
psql -c "INSERT INTO tenants (slug) VALUES ('schema-test-tenant');" >/dev/null
tenant_id=$(psql -c "SELECT id FROM tenants WHERE slug = 'schema-test-tenant';")
psql -c "INSERT INTO users (tenant_id, zitadel_id, email)
         VALUES ('$tenant_id', 'zitadel-1', 'test@example.com');" >/dev/null
user_count=$(psql -c "SELECT COUNT(*) FROM users WHERE tenant_id = '$tenant_id';")
if [[ "$user_count" != "1" ]]; then
    echo "FAIL: expected 1 user under tenant '$tenant_id', got $user_count" >&2
    exit 1
fi
echo "OK: round-trip INSERT into tenants + users succeeded"

# ── groups (009 / #87b / #174) ─────────────────────────────────────────────
# Shape: tenant_id NOT NULL FK CASCADE to tenants(id), parent_group_id
# nullable self-FK SET NULL, (tenant_id, name) unique. RLS enabled with
# tenant_isolation policy. Round-trip insert exercises live FKs.

groups_tenant_fk=$(psql -c "
    SELECT confdeltype::text FROM pg_constraint
    WHERE conrelid = 'groups'::regclass AND contype = 'f'
      AND confrelid = 'tenants'::regclass;")
if [[ "$groups_tenant_fk" != "c" ]]; then
    echo "FAIL: groups.tenant_id FK to tenants(id) not ON DELETE CASCADE (got: '$groups_tenant_fk')" >&2
    exit 1
fi
echo "OK: groups.tenant_id FK to tenants(id) ON DELETE CASCADE present"

groups_parent_fk=$(psql -c "
    SELECT confdeltype::text FROM pg_constraint
    WHERE conrelid = 'groups'::regclass AND contype = 'f'
      AND confrelid = 'groups'::regclass;")
if [[ "$groups_parent_fk" != "n" ]]; then
    echo "FAIL: groups.parent_group_id self-FK not ON DELETE SET NULL (got: '$groups_parent_fk')" >&2
    exit 1
fi
echo "OK: groups.parent_group_id self-FK ON DELETE SET NULL present"

groups_rls=$(psql -c "
    SELECT relrowsecurity FROM pg_class
    WHERE relname='groups' AND relnamespace='public'::regnamespace;")
if [[ "$groups_rls" != "t" ]]; then
    echo "FAIL: groups RLS not enabled (got: '$groups_rls')" >&2
    exit 1
fi
echo "OK: groups RLS enabled"

groups_policy=$(psql -c "
    SELECT polname FROM pg_policy
    WHERE polrelid='groups'::regclass AND polname='groups_tenant_isolation';")
if [[ "$groups_policy" != "groups_tenant_isolation" ]]; then
    echo "FAIL: groups_tenant_isolation policy not found (got: '$groups_policy')" >&2
    exit 1
fi
echo "OK: groups_tenant_isolation policy present"

# Round-trip: parent + child group with the same tenant; verify the
# self-FK SET NULL by deleting the parent and reasserting the child
# survives at root level.
psql -c "INSERT INTO groups (tenant_id, name)
         VALUES ('$tenant_id', 'engineering');" >/dev/null
parent_id=$(psql -c "SELECT id FROM groups WHERE name = 'engineering';")
psql -c "INSERT INTO groups (tenant_id, name, parent_group_id)
         VALUES ('$tenant_id', 'backend', '$parent_id');" >/dev/null
child_count=$(psql -c "SELECT COUNT(*) FROM groups
                       WHERE parent_group_id = '$parent_id';")
if [[ "$child_count" != "1" ]]; then
    echo "FAIL: expected 1 child group, got $child_count" >&2
    exit 1
fi
echo "OK: parent + child group insert succeeded"

psql -c "DELETE FROM groups WHERE id = '$parent_id';" >/dev/null
orphan_parent=$(psql -c "SELECT parent_group_id FROM groups WHERE name='backend';")
if [[ -n "$orphan_parent" ]]; then
    echo "FAIL: child group's parent_group_id should be NULL after parent DELETE (got: '$orphan_parent')" >&2
    exit 1
fi
echo "OK: parent DELETE → child parent_group_id NULL (ON DELETE SET NULL)"

# Tenant cascade: deleting the tenant takes the orphan group with it.
psql -c "DELETE FROM tenants WHERE id = '$tenant_id';" >/dev/null
post_cascade=$(psql -c "SELECT COUNT(*) FROM groups WHERE name='backend';")
if [[ "$post_cascade" != "0" ]]; then
    echo "FAIL: groups not cascaded on tenant DELETE (got: $post_cascade)" >&2
    exit 1
fi
echo "OK: tenant DELETE cascades to groups (ON DELETE CASCADE)"

echo "--- schema_test: PASS ---"
