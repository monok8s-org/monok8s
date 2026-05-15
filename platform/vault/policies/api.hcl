# Policy for the API service — read-only access to its own secrets.
path "secret/data/monok8s/api/*" {
  capabilities = ["read"]
}

# Dynamic Postgres credentials
path "database/creds/monok8s-api" {
  capabilities = ["read"]
}
