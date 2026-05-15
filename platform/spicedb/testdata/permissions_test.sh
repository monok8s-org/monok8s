#!/usr/bin/env bash
# L2 SpiceDB permission round-trip — uses rules_spicedb's ephemeral
# launcher to bring up SpiceDB, load schema.zed + seed-test.txt, then
# zed-check every permission the schema exposes.
#
# Asserts:
#   • alice (write)  → can_write + can_read + can_member  → ALL true
#   • bob   (read)   → can_read + can_member              → both true
#                    → can_write                          → false
#   • carol (member) → can_member                         → true
#                    → can_read + can_write              → both false
#   • eve   (none)   → all permissions                    → all false
set -euo pipefail

require_env() { [[ -n "${!1:-}" ]] || { echo "ERROR: \$$1 not set" >&2; exit 1; }; }
require_env SPICEDB_GRPC_ADDR
require_env SPICEDB_PRESHARED_KEY
require_env ZED_BIN

zed_check() {
    "$ZED_BIN" permission check tenant:"$1" "$2" user:"$3" \
        --endpoint="$SPICEDB_GRPC_ADDR" \
        --token="$SPICEDB_PRESHARED_KEY" \
        --insecure 2>&1
}

assert_has() {
    local user="$1" perm="$2" tenant="$3" why="$4"
    local r=$(zed_check "$tenant" "$perm" "$user")
    echo "$r" | grep -qi 'true' || { echo "FAIL: $user should have $perm on tenant:$tenant ($why)"; echo "  got: $r"; exit 1; }
    echo "PASS: $user has $perm on tenant:$tenant"
}

assert_lacks() {
    local user="$1" perm="$2" tenant="$3" why="$4"
    local r=$(zed_check "$tenant" "$perm" "$user")
    echo "$r" | grep -qi 'true' && { echo "FAIL: $user should NOT have $perm on tenant:$tenant ($why)"; echo "  got: $r"; exit 1; }
    echo "PASS: $user lacks $perm on tenant:$tenant (correctly denied)"
}

# alice has write — schema's permission rules grant write+read+member.
assert_has alice can_write  acme 'is owner via #write'
assert_has alice can_read   acme 'write implies read'
assert_has alice can_member acme 'write implies member'

# bob has read — read implies can_read + can_member, but not can_write.
assert_has   bob can_read   acme 'is reader'
assert_has   bob can_member acme 'read counts toward member'
assert_lacks bob can_write  acme 'reader has no write'

# carol is just a member — only can_member true.
assert_has   carol can_member acme 'is direct member'
assert_lacks carol can_read   acme 'member without read/write has no read'
assert_lacks carol can_write  acme 'member without write has no write'

# eve is unrelated — every check denies.
assert_lacks eve can_member acme 'unrelated to acme'
assert_lacks eve can_read   acme 'unrelated to acme'
assert_lacks eve can_write  acme 'unrelated to acme'

# Cross-tenant isolation: dave is on beta, not acme.
assert_has   dave can_member beta 'member of beta'
assert_lacks dave can_member acme 'not a member of acme'

echo "all permission checks passed"
