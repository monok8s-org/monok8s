"""Macros for SolidJS components — hermetic esbuild bundles and Jest tests."""

load("@aspect_rules_esbuild//esbuild:defs.bzl", "esbuild")
load("@aspect_rules_jest//jest:defs.bzl", "jest_test")

_SOLID_DEPS = [
    "//:node_modules/solid-js",
    "//:node_modules/@solidjs/router",
    "//:node_modules/@solidjs/meta",
    "//:node_modules/esbuild-plugin-babel",
    "//:node_modules/babel-preset-solid",
    "//:node_modules/@babel/core",
    "//:node_modules/@babel/preset-typescript",
]

_TEST_DEPS = _SOLID_DEPS + [
    "//:node_modules/@solidjs/testing-library",
    "//:node_modules/@testing-library/jest-dom",
    "//:node_modules/@testing-library/user-event",
    # Jest 28+ unbundled jest-environment-jsdom. The root jest.config.js
    # sets `testEnvironment: "jsdom"` so the package must be in the
    # runfiles tree at test time.
    "//:node_modules/jest-environment-jsdom",
    # The root jest.config.js's babel-jest transform pipeline references
    # @babel/preset-env explicitly. Without it in the runfiles tree, the
    # transform fails with "Cannot find module '@babel/preset-env'" at
    # the first test file load. esbuild-side _SOLID_DEPS doesn't need it
    # — esbuild handles JS lowering directly — so it's test-only.
    "//:node_modules/@babel/preset-env",
]

def solid_bundle(name, entry_point, srcs = [], deps = [], **kwargs):
    """Build a hermetic SolidJS SPA bundle via esbuild.

    Production builds only — use `vite dev` for local development.
    """
    esbuild(
        name = name,
        entry_point = entry_point,
        srcs = srcs,
        config = "//frontend:esbuild.config.js",
        output_dir = True,
        deps = deps + _SOLID_DEPS,
        **kwargs,
    )

def solid_test(name, srcs, deps = [], **kwargs):
    """Run Jest tests for SolidJS components.

    aspect_rules_jest 0.25+ has substantive API drift from this macro's
    original shape — `srcs` and `deps` are gone (folded into `data`),
    and `node_modules` is a required positional. This macro adapts:
    `srcs` + `deps` are merged into `data` along with the SolidJS test
    runtime deps. Consumer-facing signature stays unchanged so existing
    `solid_test(name, srcs)` calls (e.g. `frontend/BUILD.bazel:test`)
    keep working.

    Includes:
      - @solidjs/testing-library (render / renderHook helpers)
      - @testing-library/jest-dom (matchers)
      - @testing-library/user-event
      - babel-preset-solid (JSX transform consumed by the root
        jest.config.js's babel-jest pipeline — must be in the
        runfiles tree for `babel-jest` to resolve it at test time).
    """
    jest_test(
        name = name,
        node_modules = "//:node_modules",
        # aspect_rules_jest's `config` attr needs the config to live
        # in the consuming package's bin dir. The root `:jest_config`
        # copy_to_bin target stages it where the action can re-copy
        # from. Raw file refs (`//:jest.config.js`) trigger the
        # cross-package error from copy_file_to_bin_action.
        config = "//:jest_config",
        # babel-preset-solid is already in _SOLID_DEPS (and therefore
        # _TEST_DEPS via concatenation); no need to add it explicitly.
        data = srcs + deps + _TEST_DEPS,
        **kwargs,
    )
