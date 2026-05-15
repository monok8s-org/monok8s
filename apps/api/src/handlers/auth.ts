// Orchestration handlers for the OIDC BFF (#191 / #91 Phase B).
//
// Composes effects/oidc.ts (network) + handlers/sessions.ts (store +
// cookies) + packages/auth's verifyToken (JWT verify) into named
// handler functions the REST router calls. Each handler is
// plain-call-testable: pass synthetic config + fetcher + verifier, no
// HTTP framework dependency.

import { createHash, randomBytes } from "node:crypto";

import { verifyToken, type VerifiedUser } from "@monok8s/auth";

import {
  buildAuthorizeUrl,
  discoverOidcConfig,
  exchangeCodeForToken,
  type OidcDiscovery,
} from "../effects/oidc.js";
import {
  consumePendingAuth,
  createPendingAuth,
  createSession,
} from "./sessions.js";

// SpaWireUser — what GET /api/auth/me returns. Mirrors the frontend's
// `User` shape after Phase B. Role resolution from SpiceDB + tenant
// list from the DB land as sibling Issues; Phase B uses placeholders
// so the wire contract is stable from day one.
export type SpaRole = "admin" | "contributor" | "viewer";

export interface SpaWireUser {
  userId: string;
  name: string;
  email: string;
  tenantId: string;
  tenants: { id: string; name: string }[];
  role: SpaRole;
}

export interface OidcConfigSnapshot {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
}

// Default OIDC scopes — `openid profile email` covers the standard
// claims needed for VerifiedUser + the `name` claim. Custom Zitadel
// project scope can be appended via config.
const DEFAULT_SCOPES = ["openid", "profile", "email"] as const;

// ── PKCE primitives ──────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  // 43-128 char base64url-safe per RFC 7636.
  return randomBytes(32).toString("base64url");
}

export function deriveCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

// ── discovery caching ────────────────────────────────────────────────────────

// The OIDC discovery doc rarely changes; caching it at module level
// keeps each /login from re-fetching. The cache key is the issuer —
// changing issuer at runtime is not a supported config change anyway.
const discoveryCache = new Map<string, OidcDiscovery>();

export function _clearDiscoveryCache_TESTING(): void {
  discoveryCache.clear();
}

export async function getDiscovery(
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  const hit = discoveryCache.get(issuer);
  if (hit) return hit;
  const doc = await discoverOidcConfig(issuer, fetcher);
  discoveryCache.set(issuer, doc);
  return doc;
}

// ── handler results ──────────────────────────────────────────────────────────

export interface LoginResult {
  authorizeUrl: string;
  state: string;
}

export interface CallbackResult {
  sessionId: string;
  returnTo: string;
}

// ── handleLogin ──────────────────────────────────────────────────────────────
//
// Generate PKCE state, persist pending auth, build authorize URL.
// Caller writes the pending cookie and 302s the browser to authorizeUrl.

export async function handleLogin(
  config: OidcConfigSnapshot,
  opts: { returnTo?: string; fetcher?: typeof fetch } = {},
): Promise<LoginResult> {
  const discovery = await getDiscovery(config.issuer, opts.fetcher);
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = deriveCodeChallenge(codeVerifier);

  createPendingAuth(state, codeVerifier, { returnTo: opts.returnTo });

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: discovery.authorization_endpoint,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
    codeChallenge,
    scopes: config.scopes.length > 0 ? config.scopes : DEFAULT_SCOPES,
  });

  return { authorizeUrl, state };
}

// ── handleCallback ───────────────────────────────────────────────────────────
//
// Validate state cookie matches state query, exchange code for tokens,
// verify the access token, create a session, return the session ID
// the router writes into the session cookie.

export interface HandleCallbackArgs {
  config: OidcConfigSnapshot;
  // state query param from Zitadel redirect.
  stateFromQuery: string;
  // state cookie value (matches stateFromQuery for the CSRF check).
  stateFromCookie: string | null;
  // authorization code from Zitadel redirect.
  code: string;
  // Injectables for L1 tests.
  fetcher?: typeof fetch;
  verifier?: (token: string) => Promise<VerifiedUser>;
}

export async function handleCallback(
  args: HandleCallbackArgs,
): Promise<CallbackResult> {
  if (!args.stateFromCookie || args.stateFromCookie !== args.stateFromQuery) {
    throw new Error("CSRF check failed: state cookie does not match query");
  }
  const pending = consumePendingAuth(args.stateFromQuery);
  if (!pending) {
    throw new Error("Pending auth not found or expired for state");
  }

  const discovery = await getDiscovery(args.config.issuer, args.fetcher);
  const tokens = await exchangeCodeForToken(
    {
      tokenEndpoint: discovery.token_endpoint,
      code: args.code,
      codeVerifier: pending.codeVerifier,
      redirectUri: args.config.redirectUri,
      clientId: args.config.clientId,
    },
    args.fetcher,
  );

  const verify = args.verifier ?? verifyToken;
  const user = await verify(tokens.access_token);
  const sessionId = createSession(user, tokens.access_token);

  return { sessionId, returnTo: pending.returnTo ?? "/" };
}

// ── handleMe ─────────────────────────────────────────────────────────────────
//
// Map VerifiedUser into the wire shape the frontend consumes. Caller
// already looked up the session; this is the pure shaping step. Role,
// tenants[], and name resolution are placeholders for Phase B; sibling
// Issues fill them in.

export function shapeWireUser(verified: VerifiedUser): SpaWireUser {
  return {
    userId: verified.userId,
    // Placeholder. Sibling Issue fills from JWT `name` claim once
    // packages/auth's VerifiedUser captures it.
    name: verified.email.split("@")[0] ?? verified.email,
    email: verified.email,
    tenantId: verified.tenantId,
    // Placeholder. Sibling Issue replaces with DB query against the
    // user's tenant memberships.
    tenants: [{ id: verified.tenantId, name: "(active)" }],
    // Placeholder. Sibling Issue resolves the highest role the
    // principal holds in the active tenant via SpiceDB. "viewer" is
    // the floor — any authenticated user maps to at least that
    // until a SpiceDB role lookup says otherwise.
    role: "viewer",
  };
}

// ── handleLogout ─────────────────────────────────────────────────────────────
//
// Build the Zitadel end-session URL when discovery exposes one;
// otherwise return null (router clears the cookie either way).

export async function buildEndSessionUrl(
  config: OidcConfigSnapshot,
  postLogoutRedirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const discovery = await getDiscovery(config.issuer, fetcher);
  if (!discovery.end_session_endpoint) return null;
  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri);
  return url.toString();
}
