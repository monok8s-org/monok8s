#!/usr/bin/env bash
# First-time developer setup for monok8s.
# Safe to re-run — all steps are idempotent.
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

step() { echo -e "${GREEN}==>${NC} $1"; }
warn() { echo -e "${YELLOW}warn:${NC} $1"; }

step "Checking prerequisites..."
for cmd in bazelisk node pnpm go docker kind tilt kubectl atlas; do
  if ! command -v $cmd &>/dev/null; then
    warn "$cmd not found — install it before continuing"
  fi
done

step "Installing npm dependencies..."
pnpm install --frozen-lockfile

step "Copying .env.local templates..."
for template in $(find . -name '.env.local.template' -not -path '*/node_modules/*'); do
  target="${template%.template}"
  if [ ! -f "$target" ]; then
    cp "$template" "$target"
    echo "  created $target"
  else
    echo "  skipped $target (already exists)"
  fi
done

step "Starting dependency containers..."
docker compose -f docker-compose.deps.yaml up -d

step "Waiting for Postgres to be ready..."
until docker compose -f docker-compose.deps.yaml exec -T postgres pg_isready -U postgres; do
  sleep 2
done

step "Running database migrations..."
atlas migrate apply --config packages/db/atlas.hcl --env staging

step "Running Bazel build check..."
bazel build //... --config=local

step "Done. Start developing with:"
echo ""
echo "  Fast mode:  docker compose -f docker-compose.deps.yaml up -d"
echo "              cd frontend && pnpm dev"
echo "              cd apps/api && pnpm dev"
echo ""
echo "  Full mode:  kind create cluster --name monok8s-local"
echo "              tilt up"
echo ""
echo "  Tests:      bazel test //..."
echo "  Temporal:   http://localhost:8233"
echo "  Vault:      http://localhost:8200  (token: dev-root)"
echo "  Zitadel:    http://localhost:8080"
echo "  Tilt UI:    http://localhost:10350 (full mode only)"
