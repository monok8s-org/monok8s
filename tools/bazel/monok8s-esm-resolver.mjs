// ESM resolve-hook for `@monok8s/<pkg>` aliases. Loaded by
// monok8s-esm-loader.mjs via Node's module.register() API. See that
// file for the rationale.

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ALIAS_PREFIX = "@monok8s/";

function packagesRoot() {
  return process.env.MONOK8S_PACKAGES_ROOT ?? `${process.cwd()}/packages`;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(ALIAS_PREFIX)) {
    const pkg = specifier.slice(ALIAS_PREFIX.length);
    const indexPath = `${packagesRoot()}/${pkg}/src/index.js`;
    if (existsSync(indexPath)) {
      return {
        url: pathToFileURL(indexPath).href,
        format: "module",
        shortCircuit: true,
      };
    }
    // Fall through if the resolved path doesn't exist — the next resolver
    // will surface a clearer error than a stat-failed file:// URL.
  }
  return nextResolve(specifier, context);
}
