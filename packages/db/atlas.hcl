# Atlas schema migration config
#
# Two distinct flows consume this file:
#
# 1. Migration application at deploy time.
#    Driven by the Atlas Operator (rules_atlas's atlas_operator_install,
#    landed in #34) reconciling AtlasMigration CRs against the production
#    Postgres pointed at by `url`. `DATABASE_URL` is injected by an
#    ExternalSecret backed by Vault; see platform/external-secrets/.
#
# 2. Migration generation at developer time.
#    `bazel run //packages/db:migrate-diff` will (Phase 2 of #34) pair this
#    config with a hermetic dev URL supplied by an ephemeral pg_server
#    from rules_pg via the canonical $TEST_TMPDIR/<name>.env file. The
#    runnable `bazel run` target lands when rules_atlas#1 ships its
#    `atlas_migrate_diff_run` rule
#    (https://github.com/collider-bazel-extensions/rules_atlas/issues/1);
#    the consumer reads `ATLAS_DEV_URL` from the env. This replaces the
#    pre-#34 `docker://postgres/16/dev` dev URL and closes Discussion #4
#    Hermeticity Gap 4.

env "prod" {
  src = "file://packages/db/migrations"
  url = getenv("DATABASE_URL")
  dev = getenv("ATLAS_DEV_URL")
}

env "staging" {
  src = "file://packages/db/migrations"
  url = getenv("DATABASE_URL")
  dev = getenv("ATLAS_DEV_URL")
}

env "local" {
  src = "file://packages/db/migrations"
  url = getenv("DATABASE_URL")
  dev = getenv("ATLAS_DEV_URL")
}

env "tenant" {
  # Per-tenant apply (#86). Single-tenant runner invoked by:
  #   bazel run //packages/db:migrate-apply -- --tenant <tid>
  # (developer-time / one-shot) or by the Argo Workflow step
  # `apply-tenant-migrations` (production tenant-create flow,
  # submitted by Temporal per Discussion #76).
  #
  # `url` resolves to the per-tenant CNPG cluster's connection URL.
  # In production, the runner script populates TENANT_DATABASE_URL
  # from the tenant-namespace's `<cluster>-app` Secret (CNPG emits
  # this automatically per #82's design); in the L2 pg_test, the
  # test harness sets TENANT_DATABASE_URL from rules_pg's PG* env.
  #
  # `src` uses the atlas.hcl-relative `file://migrations` form (atlas
  # resolves `file://X` URLs relative to the directory containing
  # atlas.hcl) so the runner can cd into packages/db/ at runtime and
  # have the path resolve. The other envs' `file://packages/db/migrations`
  # form is workspace-root-relative and works when atlas is invoked
  # from the repo root (the rules_atlas test rules' convention).
  src = "file://migrations"
  url = getenv("TENANT_DATABASE_URL")
  dev = getenv("ATLAS_DEV_URL")
}
