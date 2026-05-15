// Tiny ESM loader for `@monok8s/<pkg>` path aliases at raw Node runtime
// (closes Discussion #45 Gap 25 / #178).
//
// Why: TypeScript path aliases (`@monok8s/*` → `packages/*/src`) resolve at
// tsc-compile-time under `moduleResolution: "bundler"` but emit verbatim
// `@monok8s/<pkg>` imports into the compiled .js. Jest handles them via
// `moduleNameMapper`; raw Node ESM does not. L2 itests that import test
// seams from cross-in-repo packages hit `ERR_MODULE_NOT_FOUND` without
// runtime resolution help.
//
// Why not tsconfig-paths: as of 4.2.0 (current latest), tsconfig-paths
// ships only a CJS register hook. The codebase is ESM-emitted; the CJS
// hook is a no-op for `import` statements.
//
// Invocation:  node --import ./tools/bazel/monok8s-esm-loader.mjs <entry.js>
//
// Configuration (env vars):
//   MONOK8S_PACKAGES_ROOT  absolute path to the packages/ directory.
//                          Defaults to "<cwd>/packages".
//
// The loader file itself is also the registration shim — calls Node's
// module.register() in the same module so the `--import` invocation
// activates the resolve hook below for subsequent imports.

import { register } from "node:module";

// Register `./monok8s-esm-resolver.mjs` (the actual resolve hook) as a
// loader, scoped to this module's URL. The hook lives in a sibling file
// because Node runs loader hooks on a worker thread; the main module
// stays as the registration entry point.
//
// import.meta.url is already a file:// URL — passing it raw is the
// canonical form. Wrapping it in pathToFileURL() double-encodes and
// produces `file://.../file:.../monok8s-esm-resolver.mjs`.
register("./monok8s-esm-resolver.mjs", import.meta.url);
