#!/usr/bin/env bash
# Provides build metadata stamped into binaries and OCI image labels.
echo "STABLE_GIT_COMMIT $(git rev-parse HEAD)"
echo "STABLE_GIT_BRANCH $(git rev-parse --abbrev-ref HEAD)"
echo "BUILD_TIMESTAMP $(date -u +%Y-%m-%dT%H:%M:%SZ)"
