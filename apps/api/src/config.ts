// AppConfig — read env vars once at server boundary (#195 — Locality).
//
// Pre-#195 every handler that needed a config value read `process.env`
// inline (anti-pattern per code-design.md §Concepts: "Locality / env-
// var-inside-effect"). Post-#195 every env var is read once at module
// load via `loadConfig()`, packed into AppConfig, and threaded
// through `ctx.config` to every tRPC procedure (via createContext) or
// imported directly at module boundary for non-tRPC handlers
// (system.ts).
//
// The cache is intentionally module-level: process env is read once
// at module import time and held for the process lifetime. Re-reads
// would be wrong — Helm / Kustomize set these at pod start; they
// don't change at runtime.

export type Cloud = "gcp" | "aws" | "azure" | "bare-metal";
export type Environment = "development" | "staging" | "production";

export interface AppConfig {
  cloud: Cloud;
  region: string;
  environment: Environment;
  // Alertmanager URL — used by the installations router to forward
  // tenant alerts. Empty string when unset; the alertmanager effect
  // handles the empty case as a no-op-but-log.
  alertmanagerUrl: string;
  // NATS URL — exported here for parity with the rest of the surface
  // even though nats.ts has its own lazy-init that reads from
  // process.env directly at connect time. Future refactor can swap
  // nats.ts to consume from AppConfig.
  natsUrl: string;
  // OIDC client identity for the SPA's Zitadel auth flow (#191 /
  // #91 Phase B). Zitadel issuer URL doubles as the OIDC discovery
  // root + JWT verify issuer (packages/auth's verifyToken reads the
  // same value via process.env.ZITADEL_ISSUER; here we also pack it
  // into AppConfig so apps/api's auth router reads through the same
  // boundary as the rest of the surface).
  // Empty zitadelIssuer / zitadelClientId / zitadelRedirectUri are
  // treated by the auth router as "OIDC not configured" — the router
  // surfaces a clear 503 rather than spinning up a half-built
  // redirect chain (dev convenience for projects bringing up other
  // pieces before Zitadel).
  zitadelIssuer: string;
  zitadelClientId: string;
  zitadelRedirectUri: string;
  // Cookie domain + secure flag. Production sets MONOK8S_COOKIE_DOMAIN
  // to the apex (e.g. ".monok8s.example.com"); dev keeps it empty so
  // the browser uses the request host. MONOK8S_COOKIE_SECURE defaults
  // to `true` in production / staging, `false` in development — so
  // http://localhost flows work without HTTPS termination during
  // local iteration.
  cookieDomain: string;
  cookieSecure: boolean;
}

const VALID_CLOUDS: ReadonlySet<Cloud> = new Set([
  "gcp",
  "aws",
  "azure",
  "bare-metal",
]);

const VALID_ENVIRONMENTS: ReadonlySet<Environment> = new Set([
  "development",
  "staging",
  "production",
]);

function parseCloud(raw: string | undefined): Cloud {
  const value = raw ?? "bare-metal";
  if (!VALID_CLOUDS.has(value as Cloud)) {
    throw new Error(
      `MONOK8S_CLOUD: invalid value ${JSON.stringify(value)}; expected one of ${[...VALID_CLOUDS].join(" / ")}`,
    );
  }
  return value as Cloud;
}

function parseEnvironment(raw: string | undefined): Environment {
  const value = raw ?? "production";
  if (!VALID_ENVIRONMENTS.has(value as Environment)) {
    throw new Error(
      `MONOK8S_ENVIRONMENT: invalid value ${JSON.stringify(value)}; expected one of ${[...VALID_ENVIRONMENTS].join(" / ")}`,
    );
  }
  return value as Environment;
}

function parseCookieSecure(
  raw: string | undefined,
  environment: Environment,
): boolean {
  if (raw === undefined) return environment !== "development";
  return raw === "1" || raw.toLowerCase() === "true";
}

// Pure function — env is passed in explicitly. Module-level callers
// pass process.env; tests pass synthetic objects. Per Rule 2: the
// boundary read happens in `loadConfig()` (the named effect at the
// process.env boundary); the parsers above are pure logic.
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const environment = parseEnvironment(env.MONOK8S_ENVIRONMENT);
  return {
    cloud: parseCloud(env.MONOK8S_CLOUD),
    region: env.MONOK8S_REGION ?? "unknown",
    environment,
    alertmanagerUrl: env.ALERTMANAGER_URL ?? "",
    natsUrl:
      env.NATS_URL ?? "nats://nats.nats.svc.cluster.local:4222",
    zitadelIssuer: env.ZITADEL_ISSUER ?? "",
    zitadelClientId: env.ZITADEL_CLIENT_ID ?? "",
    zitadelRedirectUri: env.ZITADEL_REDIRECT_URI ?? "",
    cookieDomain: env.MONOK8S_COOKIE_DOMAIN ?? "",
    cookieSecure: parseCookieSecure(env.MONOK8S_COOKIE_SECURE, environment),
  };
}

// Module-cached config singleton. Populated lazily on first access
// so test code that imports this module (e.g., for type imports)
// doesn't trigger the env read. Production code paths (handlers +
// createContext) call `getConfig()` and get the cached value.
let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached === null) {
    cached = loadConfig();
  }
  return cached;
}

// Test seam — pass a synthetic AppConfig to override the cached
// value during L1 tests. Pass null to clear back to lazy-load.
export function _setConfig_TESTING(config: AppConfig | null): void {
  cached = config;
}
