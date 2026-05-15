#!/bin/sh
# Seeds Vault dev server with the secrets and policies needed for local development.
# Runs once as a Docker init container.
set -e

echo "Waiting for Vault..."
until vault status; do sleep 2; done

echo "Enabling secrets engine..."
vault secrets enable -path=secret kv-v2 || true
vault secrets enable database || true

echo "Writing local dev secrets..."
vault kv put secret/monok8s/api/zitadel \
  issuer="http://localhost:8080" \
  client_id="local-dev"

vault kv put secret/monok8s/api/spicedb \
  preshared_key="dev-preshared-key" \
  endpoint="localhost:50051"

vault kv put secret/monok8s/workers/temporal \
  endpoint="localhost:7233" \
  namespace="default"

echo "Configuring database secrets engine..."
vault write database/config/monok8s \
  plugin_name=postgresql-database-plugin \
  allowed_roles="monok8s-api,monok8s-worker" \
  connection_url="postgresql://{{username}}:{{password}}@postgres:5432/monok8s?sslmode=disable" \
  username="postgres" \
  password="postgres"

vault write database/roles/monok8s-api \
  db_name=monok8s \
  creation_statements="CREATE ROLE '{{name}}' WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}'; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO '{{name}}';" \
  default_ttl="1h" \
  max_ttl="24h"

echo "Writing Vault policies..."
vault policy write monok8s-api - <<EOF
path "secret/data/monok8s/api/*" { capabilities = ["read"] }
path "database/creds/monok8s-api" { capabilities = ["read"] }
EOF

echo "Vault init complete."
