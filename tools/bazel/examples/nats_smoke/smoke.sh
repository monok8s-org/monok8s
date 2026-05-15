#!/usr/bin/env bash
# Asserts that itest_suite exposed canonical + native env keys for the
# single nats_server server. The actual nats-server liveness is proven
# by nats_health_check (gates the test from running until the env file
# materializes); this smoke just confirms env wiring made it through
# the itest_suite wrapper.
#
# Shape mirrors tools/bazel/examples/pg_spicedb/smoke.sh.

set -euo pipefail

if [[ -z "${NATS_URL:-}" ]]; then
    echo "smoke: NATS_URL not set" >&2
    exit 1
fi

# Native nats_server keys must also pass through.
for var in NATS_HOST NATS_PORT; do
    if [[ -z "${!var:-}" ]]; then
        echo "smoke: native nats_server key $var not set" >&2
        exit 1
    fi
done

# Canonical NATS_URL should match the native NATS_HOST:NATS_PORT.
expected="nats://${NATS_HOST}:${NATS_PORT}"
if [[ "$NATS_URL" != "$expected" ]]; then
    echo "smoke: NATS_URL=$NATS_URL does not match $expected" >&2
    exit 1
fi

echo "smoke: NATS_URL=$NATS_URL"
