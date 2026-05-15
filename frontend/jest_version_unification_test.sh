#!/usr/bin/env bash
# Future-proofing test for #193 — assert every jest-family pin in the
# workspace package.json uses the same semver major. Catches the
# jest-cli 30 + jest 29 skew that produced the
# _moduleMocker.clearMocksOnScope NameError under jsdom and forced
# Phase A (#91) to defer auth.test.tsx.

set -euo pipefail

PKG="${1:?missing path to package.json}"

# Keys whose major versions must agree. jest-cli already depended on
# jest-runtime 30.x transitively before #193 — the skew showed up
# because jest, jest-environment-jsdom, and babel-jest were stranded
# on 29.x. Keeping the full list explicit so a future drift in any
# direction surfaces.
KEYS=(
  "jest"
  "jest-cli"
  "jest-environment-jsdom"
  "@jest/globals"
  "@types/jest"
  "babel-jest"
)

extract_major() {
  local key="$1"
  local line
  line=$(grep -E "\"${key}\":[[:space:]]*\"[^\"]*\"" "$PKG" || true)
  if [[ -z "$line" ]]; then
    return 1
  fi
  # Use | as sed delimiter so / in @jest/globals doesn't collide.
  echo "$line" | sed -E "s|.*\"${key}\":[[:space:]]*\"[^0-9]*([0-9]+)\\..*|\\1|"
}

declare -a MAJORS=()
for key in "${KEYS[@]}"; do
  major=$(extract_major "$key") || {
    echo "FAIL: ${key} not found in $PKG" >&2
    exit 1
  }
  echo "${key} -> major ${major}"
  MAJORS+=("$major")
done

first="${MAJORS[0]}"
for m in "${MAJORS[@]:1}"; do
  if [[ "$m" != "$first" ]]; then
    echo "FAIL: jest-family majors diverge — expected all ${first}, got ${MAJORS[*]}" >&2
    exit 1
  fi
done

echo "OK: jest-family pins unified on major ${first}"
