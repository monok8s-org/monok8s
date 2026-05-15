"""atlas_migrate_apply_run — runnable rule that drives `atlas migrate
apply` against a target URL supplied via env.

Mirrors the shape of `rules_atlas//private:atlas_migrate_diff_run.bzl`
(which `bazel run`'s migration generation against a dev_service). Apply
is simpler: no dev_service is needed because `atlas migrate apply`
doesn't generate migrations, it just applies the committed set against
a URL the consumer provides.

Used by `//packages/db:migrate-apply` (#86) — the single-tenant
migration runner invoked by `bazel run //packages/db:migrate-apply --
--tenant <tid>` (operator-time) or by the Argo Workflow step
`apply-tenant-migrations` (production tenant-create flow).

This local macro lives in `tools/bazel/` rather than upstream
`rules_atlas` because (a) the consumer surface so far is one BUILD
file, (b) the macro is small (~40 LOC + template), and (c) the
upstream rules_atlas Issue for a properly-vendored apply rule is the
right cadence-mismatch resolution (filed as a follow-up). When the
upstream rule lands, this local copy retires.
"""

load("@bazel_skylib//:bzl_library.bzl", "bzl_library")  # noqa: unused — convention.

def _atlas_migrate_apply_run_impl(ctx):
    tc = ctx.toolchains["@rules_atlas//toolchain:atlas"]
    atlas_bin = tc.atlas.atlas_bin

    out = ctx.actions.declare_file(ctx.label.name + ".sh")
    ctx.actions.expand_template(
        template = ctx.file._tmpl,
        output = out,
        substitutions = {
            "__ATLAS_BIN__": atlas_bin.short_path,
            "__ATLAS_CONFIG__": ctx.file.atlas_config.short_path,
            "__ATLAS_ENV__": ctx.attr.env,
            "__MIGRATIONS_DIR__": ctx.attr.migrations_dir,
        },
        is_executable = True,
    )

    runfiles = ctx.runfiles(
        files = [
            atlas_bin,
            ctx.file.atlas_config,
        ] + ctx.files.migrations,
    )

    return [DefaultInfo(executable = out, runfiles = runfiles)]

atlas_migrate_apply_run = rule(
    implementation = _atlas_migrate_apply_run_impl,
    executable = True,
    attrs = {
        "atlas_config": attr.label(
            allow_single_file = [".hcl"],
            mandatory = True,
            doc = "Atlas config file (`atlas.hcl`). Must declare an env " +
                  "block matching the `env` attribute, whose `url` resolves " +
                  "via `getenv()` — typically `TENANT_DATABASE_URL` for " +
                  "the `tenant` env.",
        ),
        "migrations": attr.label_list(
            allow_files = True,
            doc = "Migration files (e.g. the srcs of a `postgres_schema` " +
                  "target). Staged into runfiles so atlas can read them " +
                  "via the path declared in atlas.hcl's `src` field.",
        ),
        "migrations_dir": attr.string(
            default = "packages/db/migrations",
            doc = "Path (relative to workspace root inside runfiles) where " +
                  "the migrations live. Used by the wrapper to cd into the " +
                  "runfiles tree's mirror of the workspace so atlas's " +
                  "`file://packages/db/migrations` src reference resolves.",
        ),
        "env": attr.string(
            default = "tenant",
            doc = "Atlas env section name (`atlas migrate apply --env <env>`).",
        ),
        "_tmpl": attr.label(
            default = "//tools/bazel:atlas_migrate_apply_run.sh.tmpl",
            allow_single_file = True,
        ),
    },
    toolchains = ["@rules_atlas//toolchain:atlas"],
)
