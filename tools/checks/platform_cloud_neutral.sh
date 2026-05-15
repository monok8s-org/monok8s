#!/usr/bin/env bash
# Scans platform/* for cloud-only API references that leak into the
# core (cloud-agnostic) platform paths. Non-zero exit when any leak is
# found.
#
# Per the cloud-neutral charter (see `platform/CLAUDE.md` + Discussion
# #4), platform components must work on bare metal first. Cloud-specific
# manifests are isolated to per-cloud overlay paths; this scanner is the
# enforcement layer.
#
# Allowed overlay paths (one glob each):
#   - platform/*/overlays/aws/**
#   - platform/*/overlays/gcp/**
#   - platform/*/overlays/azure/**
#   - platform/*/aws/**             — flat-shape per-cloud subdirs (security-findings, iam-writeback)
#   - platform/*/gcp/**
#   - platform/*/azure/**
#
# Forbidden API references (extend as new cloud APIs surface):
#   *.upbound.io       — Crossplane provider APIs (AWS / GCP / Azure / Tencent)
#   *.amazonaws.com    — AWS native API references in CRDs / manifests
#   *.googleapis.com   — GCP native API references
#   *.azure.com        — Azure native API references (post-Upbound)
#   *.eks.amazonaws.com  — explicit EKS
#   compute.googleapis.com  — explicit GCE
#
# Usage: tools/checks/platform_cloud_neutral.sh [scan-root]
#   scan-root defaults to `platform`.

set -euo pipefail

SCAN_ROOT="${1:-platform}"

# Patterns that count as cloud-only leaks if found OUTSIDE an allowed
# overlay path. Patterns are narrow to avoid false positives on:
#   - Envoy / protobuf `type.googleapis.com/...` type URLs (standard)
#   - CRD description text that names cloud services in prose
#
# Anchor `apiVersion:` for Crossplane resource leaks (`*.upbound.io`
# group names always appear as `apiVersion: <group>/<version>`).
# Anchor hostname-style references via `://` or `:` followed by the
# host so we catch `queueURL: https://sqs....amazonaws.com/...` and
# `endpoint: foo.googleapis.com` shapes without flagging prose.
FORBIDDEN_PATTERNS=(
  'apiVersion: *[^ ]*\.upbound\.io'
  '://[^/ ]*\.amazonaws\.com'
  '://[^/ ]*\.googleapis\.com[^/]'
  ':[ ]*[a-zA-Z0-9.-]+\.eks\.amazonaws\.com'
  ': *compute\.googleapis\.com'
  'apiVersion: *[^ ]*eventgrid\.azure'
  'apiVersion: *[^ ]*servicebus\.azure'
)

# Allowed-overlay paths — leaks inside these are expected.
# Matched against the file path with `grep -E`. The patterns are
# anchored to the platform/ root.
ALLOWED_OVERLAY_PATTERNS=(
  '^platform/[^/]+/overlays/(aws|gcp|azure)/'
  '^platform/[^/]+/(aws|gcp|azure)/'
)

# Build the allowed-path test as one regex (alternation).
ALLOWED_REGEX="$(IFS='|'; echo "${ALLOWED_OVERLAY_PATTERNS[*]}")"

# Build the forbidden-pattern test as one regex (alternation).
FORBIDDEN_REGEX="$(IFS='|'; echo "${FORBIDDEN_PATTERNS[*]}")"

# Find candidate files in the scan root. Limit to *.yaml + *.yml +
# *.json — that's where Crossplane / K8s manifests live.
mapfile -t CANDIDATES < <(
  find "$SCAN_ROOT" \
    -type f \
    \( -name '*.yaml' -o -name '*.yml' -o -name '*.json' \) \
    2>/dev/null
)

LEAK_COUNT=0
for f in "${CANDIDATES[@]}"; do
  # Skip files in allowed overlay paths.
  if [[ "$f" =~ $ALLOWED_REGEX ]]; then
    continue
  fi
  # Search the file for any forbidden pattern.
  if grep -E -n "$FORBIDDEN_REGEX" "$f" > /dev/null 2>&1; then
    echo "LEAK: $f" >&2
    grep -E -n "$FORBIDDEN_REGEX" "$f" | sed 's/^/  /' >&2
    LEAK_COUNT=$((LEAK_COUNT + 1))
  fi
done

if [[ $LEAK_COUNT -gt 0 ]]; then
  echo "" >&2
  echo "Found $LEAK_COUNT file(s) with cloud-only API references in non-overlay paths." >&2
  echo "Either move the manifest into a per-cloud overlay path or extend the allow-list in tools/checks/platform_cloud_neutral.sh." >&2
  exit 1
fi

echo "OK: no cloud-API leaks in non-overlay platform paths"
