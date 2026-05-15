#!/usr/bin/env bash
# L2 SpiceDB permission round-trip for packages/auth/schema.zed.
#
# rules_spicedb v0.2 brings up an ephemeral SpiceDB, imports the schema
# (via spicedb_schema) and the seed relationships (via spicedb_relationships
# → zed import), then exec's this script with SPICEDB_GRPC_ADDR /
# SPICEDB_PRESHARED_KEY / ZED_BIN in env.
#
# Covers every AC bullet on Issue #77.
set -euo pipefail

require_env() { [[ -n "${!1:-}" ]] || { echo "ERROR: \$$1 not set" >&2; exit 1; }; }
require_env SPICEDB_GRPC_ADDR
require_env SPICEDB_PRESHARED_KEY
require_env ZED_BIN

# ─────────────────────────────────────────────────────────────────────────
# Helpers — wrap `zed permission check` against the ephemeral SpiceDB and
# match against the textual `Allowed/HasPermission/permissionship` shape
# zed emits in insecure mode. Caveat checks pass `--caveat-context=<json>`.
# ─────────────────────────────────────────────────────────────────────────

zed_check() {
    # $1 resource (e.g. tenant:acme)  $2 permission  $3 subject (e.g. user:bob)
    # $4 optional caveat-context JSON (passed verbatim)
    local resource="$1" perm="$2" subject="$3" cavctx="${4:-}"
    if [[ -n "$cavctx" ]]; then
        "$ZED_BIN" permission check "$resource" "$perm" "$subject" \
            --endpoint="$SPICEDB_GRPC_ADDR" \
            --token="$SPICEDB_PRESHARED_KEY" \
            --insecure \
            --caveat-context="$cavctx" 2>&1
    else
        "$ZED_BIN" permission check "$resource" "$perm" "$subject" \
            --endpoint="$SPICEDB_GRPC_ADDR" \
            --token="$SPICEDB_PRESHARED_KEY" \
            --insecure 2>&1
    fi
}

# zed emits one of:
#   true                          — unconditional grant
#   false                         — unconditional deny
#   conditional permission        — caveat'd grant missing context (treat as deny)
#   no permission                 — explicit deny
# Match true on its own line OR the explicit "has permission" textual form.
is_allowed() {
    grep -qiE '^(true|has permission)$|"permissionship": *"PERMISSIONSHIP_HAS_PERMISSION"' <<< "$1"
}

assert_allowed() {
    # $1 resource  $2 perm  $3 subject  $4 why  [$5 caveat-context json]
    local r=$(zed_check "$1" "$2" "$3" "${5:-}")
    if is_allowed "$r"; then
        echo "PASS: $3 has $2 on $1 ($4)"
    else
        echo "FAIL: $3 should have $2 on $1 ($4)"
        echo "  got: $r"
        exit 1
    fi
}

assert_denied() {
    local r=$(zed_check "$1" "$2" "$3" "${5:-}")
    if is_allowed "$r"; then
        echo "FAIL: $3 should NOT have $2 on $1 ($4)"
        echo "  got: $r"
        exit 1
    fi
    echo "PASS: $3 lacks $2 on $1 (correctly denied — $4)"
}

# ─────────────────────────────────────────────────────────────────────────
# AC: Owner cascade — bob has every owner-derived permission.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed tenant:acme read               user:bob 'owner has read'
assert_allowed tenant:acme write              user:bob 'owner has write'
assert_allowed tenant:acme manage_members     user:bob 'owner has manage_members'
assert_allowed tenant:acme manage_billing     user:bob 'owner has manage_billing'
assert_allowed tenant:acme manage_settings    user:bob 'owner has manage_settings'
assert_allowed tenant:acme delete             user:bob 'owner has delete'
assert_allowed tenant:acme transfer_ownership user:bob 'owner has transfer_ownership'

# ─────────────────────────────────────────────────────────────────────────
# AC: Suspended owner cannot delete or transfer.
# Jane is owner BUT also in tenant:acme#suspended.
# ─────────────────────────────────────────────────────────────────────────
assert_denied  tenant:acme delete             user:jane 'suspended owner loses delete'
assert_denied  tenant:acme transfer_ownership user:jane 'suspended owner loses transfer_ownership'
# Sanity: jane also loses write + manage_members.
assert_denied  tenant:acme write              user:jane 'suspended owner loses write'

# ─────────────────────────────────────────────────────────────────────────
# AC: Denied user has nothing — denied subtracts from active + write +
# every manage_*, overriding the role.
# Iris is admin BUT also in tenant:acme#denied.
# ─────────────────────────────────────────────────────────────────────────
assert_denied  tenant:acme read           user:iris 'denied admin loses read'
assert_denied  tenant:acme write          user:iris 'denied admin loses write'
assert_denied  tenant:acme manage_members user:iris 'denied admin loses manage_members'

# ─────────────────────────────────────────────────────────────────────────
# AC: Platform admin bypasses every tenant-level state.
# Alice is platform:monok8s#super_admin → platform->administrate cascade
# unions into every tenant permission.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed tenant:acme read               user:alice 'platform admin reads any tenant'
assert_allowed tenant:acme write              user:alice 'platform admin writes any tenant'
assert_allowed tenant:acme delete             user:alice 'platform admin can delete'
assert_allowed tenant:acme manage_members     user:alice 'platform admin manage_members'
# Bypass holds even on tenant:beta where alice has no direct role.
assert_allowed tenant:beta  read              user:alice 'platform admin reaches every tenant'

# ─────────────────────────────────────────────────────────────────────────
# AC: Suspended admin loses write — sanity for the suspended path on a
# non-owner role.
# ─────────────────────────────────────────────────────────────────────────
assert_denied  tenant:acme write          user:henry 'suspended admin loses write'
assert_denied  tenant:acme manage_members user:henry 'suspended admin loses manage_members'

# ─────────────────────────────────────────────────────────────────────────
# AC: Group membership transitively grants tenant role.
# group:engineering holds admin on acme; kate is direct member.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed tenant:acme write          user:kate 'kate inherits admin via group:engineering'
assert_allowed tenant:acme manage_members user:kate 'group admin → manage_members'

# ─────────────────────────────────────────────────────────────────────────
# AC: Nested group — group:senior_eng is nested under engineering. liam
# is a senior_eng member; the chain
#   tenant:acme#admin@group:engineering#membership
#   group:engineering#member@group:senior_eng#membership
#   group:senior_eng#member@user:liam
# resolves liam as an admin on acme.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed tenant:acme write          user:liam 'nested group grants admin transitively'
assert_allowed tenant:acme manage_members user:liam 'nested group → manage_members'

# ─────────────────────────────────────────────────────────────────────────
# AC: Service account holding admin with ip_allowlist caveat.
# ci_runner is admin with allowed_ips=["10.0.0.1","10.0.0.2"]. Check
# behavior with matching + non-matching client_ip.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed tenant:acme write service_account:ci_runner \
    'SA admin granted when client_ip is in allowlist' \
    '{"client_ip":"10.0.0.1"}'
assert_denied  tenant:acme write service_account:ci_runner \
    'SA admin denied when client_ip not in allowlist' \
    '{"client_ip":"192.168.1.99"}'
# Without caveat context entirely, SpiceDB returns conditional → treat as deny.
assert_denied  tenant:acme write service_account:ci_runner \
    'SA admin without caveat context → conditional (deny)'

# ─────────────────────────────────────────────────────────────────────────
# AC: Expiry caveat. Nina holds admin until 2026-04-18T00:00:00Z.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed tenant:acme write user:nina \
    'temporary grant valid before expiry' \
    '{"now":"2026-04-17T00:00:00Z"}'
assert_denied  tenant:acme write user:nina \
    'temporary grant denied after expiry' \
    '{"now":"2026-04-19T00:00:00Z"}'
assert_denied  tenant:acme write user:nina \
    'temporary grant without `now` → conditional (deny)'

# ─────────────────────────────────────────────────────────────────────────
# AC: Cross-tenant isolation. Mike is a member of tenant:beta only.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed tenant:beta  read  user:mike 'mike is member of beta'
assert_denied  tenant:acme  read  user:mike 'mike has no role on acme'
assert_denied  tenant:acme  write user:mike 'mike has no write on acme'

# ─────────────────────────────────────────────────────────────────────────
# AC: Last-owner protection lookup. LookupSubjects for transfer_ownership
# on tenant:acme must return ≥ 1 owner so the application-layer
# last-owner guard has something to verify against. Seed has bob + carol
# as unsuspended owners (jane is suspended so does not contribute).
# ─────────────────────────────────────────────────────────────────────────
lookup_out=$("$ZED_BIN" permission lookup-subjects tenant:acme transfer_ownership user \
    --endpoint="$SPICEDB_GRPC_ADDR" \
    --token="$SPICEDB_PRESHARED_KEY" \
    --insecure 2>&1)
# Output one subject per line; count unique user IDs reported (bob + carol).
unsuspended_owners=$(echo "$lookup_out" | grep -cE '\buser:[a-z]+\b' || true)
if [[ "$unsuspended_owners" -lt 1 ]]; then
    echo "FAIL: LookupSubjects for transfer_ownership returned no owners"
    echo "  raw output: $lookup_out"
    exit 1
fi
echo "PASS: LookupSubjects(transfer_ownership) returned $unsuspended_owners eligible owner(s)"

# ─────────────────────────────────────────────────────────────────────────
# AC #98a: system tenant gates create_tenants.
# user:bootstrap_admin holds only_system_can_create_tenants on
# system:monok8s — seeded at install time by the bootstrap Job. No one
# else (including platform admin alice) should hold the relation
# directly. The current schema deliberately keeps create_tenants
# tightly scoped: platform admin reads everything but cannot create
# tenants on the system resource without explicit relation membership.
# ─────────────────────────────────────────────────────────────────────────
assert_allowed system:monok8s create_tenants user:bootstrap_admin \
    'bootstrap admin has create_tenants on system:monok8s'
assert_denied  system:monok8s create_tenants user:bob \
    'tenant owner does NOT have create_tenants on system:monok8s'
assert_denied  system:monok8s create_tenants user:dave \
    'tenant admin does NOT have create_tenants on system:monok8s'
assert_denied  system:monok8s create_tenants user:alice \
    'platform super_admin does NOT have create_tenants on system:monok8s (no direct relation)'

echo "all packages/auth permission checks passed"
