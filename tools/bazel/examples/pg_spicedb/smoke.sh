#!/usr/bin/env bash
# Asserts that itest_suite exposed canonical env keys for both servers.
# Bringing pg + spicedb up under rules_itest with health-checks satisfied,
# and the wrapper sourcing both .env files, is the cross-product exercise.

set -euo pipefail

if [[ -z "${PG_URL:-}" ]]; then
    echo "smoke: PG_URL not set" >&2
    exit 1
fi

if [[ -z "${SPICEDB_ADDR:-}" ]]; then
    echo "smoke: SPICEDB_ADDR not set" >&2
    exit 1
fi

# Native pg_server keys must also be present (pre-canonical pass-through).
for var in PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD; do
    if [[ -z "${!var:-}" ]]; then
        echo "smoke: native pg_server key $var not set" >&2
        exit 1
    fi
done

# Native spicedb_server keys must also be present.
if [[ -z "${SPICEDB_GRPC_ADDR:-}" ]]; then
    echo "smoke: native SPICEDB_GRPC_ADDR not set" >&2
    exit 1
fi

echo "smoke: PG_URL=$PG_URL SPICEDB_ADDR=$SPICEDB_ADDR"
