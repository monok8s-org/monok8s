#!/usr/bin/env bash
# packages/db/test/migrate_apply_test.sh (#86)
#
# L2 hermetic test: rules_pg's pg_test launcher initdb's an ephemeral
# Postgres cluster (EMPTY schema — :_empty_schema_for_apply). This
# script:
#
#   1. Constructs TENANT_DATABASE_URL from the PG* env vars rules_pg
#      provides (PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD).
#   2. Invokes the //packages/db:migrate-apply runner against the
#      empty DB. The runner reads TENANT_DATABASE_URL (bypassing the
#      kubectl Secret resolution path that production uses) and runs
#      `atlas migrate apply --config file://packages/db/atlas.hcl
#      --env tenant`.
#   3. Asserts post-apply schema shape via psql — tables exist, FKs
#      correct, NOT NULL constraints, indexes (same assertions as the
#      sibling schema_test.sh; the goal is "the runner applied the
#      same migrations the schema_test exercises").
#
# This proves the runner sh_binary correctly wraps atlas migrate apply
# AND the atlas.hcl `tenant` env block resolves the URL from
# TENANT_DATABASE_URL AND migrations land cleanly against a fresh DB.

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

# Resolve the migrate-apply runner via the runfiles tree. pg_test runs
# under a launcher that sets TEST_SRCDIR.
RUNFILES_DIR="${RUNFILES_DIR:-${TEST_SRCDIR:-}}"
if [[ -z "$RUNFILES_DIR" ]]; then
    echo "ERROR: cannot resolve runfiles tree" >&2
    exit 1
fi
RUNNER=""
for candidate in \
    "${RUNFILES_DIR}/_main/packages/db/migrate-apply" \
    "${RUNFILES_DIR}/_main/packages/db/migrate-apply.sh"; do
    if [[ -x "$candidate" ]]; then
        RUNNER="$candidate"
        break
    fi
done
if [[ -z "$RUNNER" ]]; then
    echo "ERROR: migrate-apply runner not found in runfiles" >&2
    find "$RUNFILES_DIR" -name "migrate-apply*" 2>/dev/null | head -5 >&2 || true
    exit 1
fi
echo "--- migrate_apply_test: runner at $RUNNER ---"

# Bypass tenant-arg path by pre-setting TENANT_DATABASE_URL from
# rules_pg's PG* env. Matches the runner's documented test-mode shape.
export TENANT_DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=disable"
echo "--- migrate_apply_test: TENANT_DATABASE_URL set, runner reads atlas.hcl env=tenant ---"

# Drive the runner. The atlas binary lives in the runner's runfiles;
# the runner's wrapper script cd's into the runfiles _main mirror so
# `file://packages/db/migrations` resolves.
"$RUNNER"

echo "--- migrate_apply_test: atlas migrate apply completed; asserting schema ---"

psql() {
    PGPASSWORD="$PGPASSWORD" command psql \
        -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
        --no-password -v ON_ERROR_STOP=1 -t -A "$@"
}

assert_table() {
    local table="$1"
    local count
    count=$(psql -c "SELECT COUNT(*) FROM information_schema.tables
                     WHERE table_schema='public' AND table_name='$table';")
    if [[ "$count" != "1" ]]; then
        echo "FAIL: table '$table' not found after runner apply" >&2
        exit 1
    fi
    echo "OK: table '$table' present"
}

assert_table tenants
assert_table users

# FK shape: users.tenant_id -> tenants(id) ON DELETE CASCADE NOT NULL.
fk_check=$(psql -c "
    SELECT conname || ' ' || confdeltype::text FROM pg_constraint
    WHERE conrelid = 'users'::regclass AND contype = 'f'
      AND confrelid = 'tenants'::regclass;")
if [[ "$fk_check" != *" c" ]]; then
    echo "FAIL: users → tenants FK not ON DELETE CASCADE (got: '$fk_check')" >&2
    exit 1
fi
echo "OK: users.tenant_id FK shape correct"

nullable=$(psql -c "
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='tenant_id';")
if [[ "$nullable" != "NO" ]]; then
    echo "FAIL: users.tenant_id should be NOT NULL" >&2
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
echo "OK: users_tenant_id_idx present"

# Round-trip insert proves live FK semantics.
psql -c "INSERT INTO tenants (slug) VALUES ('migrate-apply-test-tenant');" >/dev/null
tenant_id=$(psql -c "SELECT id FROM tenants WHERE slug = 'migrate-apply-test-tenant';")
psql -c "INSERT INTO users (tenant_id, zitadel_id, email)
         VALUES ('$tenant_id', 'zitadel-mat-1', 'mat@example.com');" >/dev/null
user_count=$(psql -c "SELECT COUNT(*) FROM users WHERE tenant_id = '$tenant_id';")
if [[ "$user_count" != "1" ]]; then
    echo "FAIL: round-trip insert failed (count=$user_count)" >&2
    exit 1
fi
echo "OK: round-trip INSERT through migrate-apply-installed schema"

echo "--- migrate_apply_test: PASS ---"
