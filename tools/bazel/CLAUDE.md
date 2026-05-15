# tools/bazel/

Bazel macros for monok8s. Use these instead of calling raw rules directly.

## Available macros

| Macro | File | Use for |
|---|---|---|
| `solid_bundle()` | `solid.bzl` | SolidJS esbuild SPA bundle (production) |
| `solid_test()` | `solid.bzl` | Jest tests for SolidJS components |
| `app_image(name, language, binary)` | `oci.bzl` | OCI image for a service. `language` is `"node"` or `"go"`; the macro selects a digest-pinned base. |
| `frontend_image(name, bundle)` | `oci.bzl` | OCI image for the SolidJS SPA (nginx base, digest-pinned). |
| `itest_suite(name, servers, test)` | `itest.bzl` | Multi-server hermetic integration test. `servers` is a subset of `{pg, temporal, spicedb, k8s, nats}`; the macro brings up `*_server` targets via `rules_itest` and exports canonical env (`PG_URL` / `TEMPORAL_ADDR` / `SPICEDB_ADDR` / `KUBECONFIG` / `NATS_URL`) to the test. |

For Temporal workflow determinism testing, use `rules_temporal` directly — load `temporal_build` + `temporal_workflow_history` + `temporal_test` from `@rules_temporal//:defs.bzl`. By convention the consumer target is named `replay_test`. See `tools/bazel/temporal.bzl` for the usage shape.

## When to add a new macro
Only add a macro when 3+ BUILD files repeat the same pattern.
A macro with one user is premature abstraction — use the raw rule until then.

## When adding a new .bzl file in this directory

Every `.bzl` file under `tools/bazel/` must have a matching `bzl_library`
target in `tools/bazel/BUILD.bazel`. Without it, `load("//tools/bazel:foo.bzl", ...)`
from another package fails to resolve — the file exists but Bazel does
not see this directory as a package that exposes it.

Convention: one `bzl_library` per `.bzl`, named after the file stem
(e.g. `solid.bzl` → `bzl_library(name = "solid", srcs = ["solid.bzl"])`),
with `visibility = ["//visibility:public"]`. Update the BUILD.bazel in
the same change that adds the `.bzl` file.

## Dep lists
`_SOLID_DEPS` and `_TEST_DEPS` in `solid.bzl` are the canonical dependency lists
for SolidJS builds and tests. Update them here when adding a new shared dep —
never add the same dep to individual BUILD files.

## BUILD file conventions across the repo
- One `BUILD.bazel` per directory that has buildable targets
- Prefer `glob()` over listing files individually for `srcs`
- All OCI push targets are named `<name>_push` (e.g. `image_push`)
- All test targets are named `test` (single target) or `<name>_test` (multiple)
- Temporal replay test targets are always named `replay_test`

## Visibility
Default visibility is private. Explicitly set `visibility = ["//visibility:public"]`
only on targets that are legitimately consumed across the repo (shared packages, macros).
