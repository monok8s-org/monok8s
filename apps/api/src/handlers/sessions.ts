// Session store + cookie helpers for the OIDC BFF (#191 / #91 Phase B).
//
// Sessions are opaque server-side records keyed by a random ID. The
// session ID is the only thing that lands in the cookie; JWTs and
// refresh tokens stay server-side.
//
// In-memory Map for v1 — restart loses sessions, which is acceptable
// while we're operating from a single apps/api pod in dev. Redis-backed
// store ships as a follow-up Issue when horizontal-scale concerns
// surface.
//
// Per code-design.md Rule 10 injectable_seams + the project-rules
// Closes-injectable_seams posture: the module-level Map is paired
// with `_setStore_TESTING` so L1 tests get a fresh Map per case.

import { randomBytes } from "node:crypto";

import type { VerifiedUser } from "@monok8s/auth";

// SessionRecord — server-side session state. The bare minimum to
// answer GET /api/auth/me without re-verifying the JWT each call:
// VerifiedUser is what callers consume. Tokens are kept so Phase
// C's tRPC client can read the access token for downstream calls.
export interface SessionRecord {
  user: VerifiedUser;
  accessToken: string;
  // ms-since-epoch. After this, /me returns 401 and clients re-flow.
  expiresAt: number;
}

// PendingAuth — short-lived per-redirect state carrying the PKCE
// verifier between /login (redirect to Zitadel) and /callback (code
// exchange). Indexed by `state` (which echoes through the OIDC
// redirect chain) and matched against the per-redirect cookie.
export interface PendingAuth {
  codeVerifier: string;
  // ms-since-epoch. After this the pending state is GC'd; callbacks
  // with expired state behave like state-not-found.
  expiresAt: number;
  // Optional return path — when /login was invoked with ?returnTo=
  // we redirect there post-callback instead of "/".
  returnTo?: string;
}

const SESSION_COOKIE_NAME = "monok8s_session";
const PENDING_COOKIE_NAME = "monok8s_pending";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;     // 8 hours
const PENDING_TTL_MS = 5 * 60 * 1000;          // 5 minutes

// Module-level stores. Replaceable via _set*_TESTING — L1 tests use
// fresh Maps so they don't see each other's entries.
let sessions: Map<string, SessionRecord> = new Map();
let pending: Map<string, PendingAuth> = new Map();

export function _setStore_TESTING(opts: {
  sessions?: Map<string, SessionRecord> | null;
  pending?: Map<string, PendingAuth> | null;
}): void {
  if (opts.sessions !== undefined) {
    sessions = opts.sessions ?? new Map();
  }
  if (opts.pending !== undefined) {
    pending = opts.pending ?? new Map();
  }
}

// ── session lifecycle ────────────────────────────────────────────────────────

// createSession — mint a random session ID, persist the record, return
// the ID. Caller writes the ID into a Set-Cookie response header via
// formatSessionCookie.
export function createSession(
  user: VerifiedUser,
  accessToken: string,
  now: number = Date.now(),
): string {
  const id = randomBytes(32).toString("hex");
  sessions.set(id, {
    user,
    accessToken,
    expiresAt: now + SESSION_TTL_MS,
  });
  return id;
}

// lookupSession — return the live SessionRecord for a session ID, or
// null when the ID is unknown or the record has expired. Expired
// records get GC'd on lookup so the live Map doesn't accumulate.
export function lookupSession(
  id: string | null,
  now: number = Date.now(),
): SessionRecord | null {
  if (!id) return null;
  const rec = sessions.get(id);
  if (!rec) return null;
  if (rec.expiresAt <= now) {
    sessions.delete(id);
    return null;
  }
  return rec;
}

// deleteSession — return true iff a record was actually removed.
export function deleteSession(id: string | null): boolean {
  if (!id) return false;
  return sessions.delete(id);
}

// ── pending-auth lifecycle ───────────────────────────────────────────────────

export function createPendingAuth(
  state: string,
  codeVerifier: string,
  opts: { returnTo?: string; now?: number } = {},
): void {
  pending.set(state, {
    codeVerifier,
    expiresAt: (opts.now ?? Date.now()) + PENDING_TTL_MS,
    returnTo: opts.returnTo,
  });
}

export function consumePendingAuth(
  state: string | null,
  now: number = Date.now(),
): PendingAuth | null {
  if (!state) return null;
  const rec = pending.get(state);
  if (!rec) return null;
  pending.delete(state);
  if (rec.expiresAt <= now) return null;
  return rec;
}

// ── cookie formatting / parsing ──────────────────────────────────────────────

export interface CookieFlags {
  secure: boolean;
  // Empty string → no Domain attribute (browser uses request host).
  domain: string;
  // Path the cookie applies to; defaults to "/" which is what every
  // session-cookie use-case here wants.
  path?: string;
  // Override the cookie's Max-Age (seconds). Defaults match the TTL
  // of the matching server-side store: session = SESSION_TTL_MS,
  // pending = PENDING_TTL_MS. Negative = delete (Max-Age=0).
  maxAgeSeconds?: number;
}

function formatCookie(
  name: string,
  value: string,
  flags: CookieFlags,
  defaultMaxAgeSeconds: number,
): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${flags.path ?? "/"}`);
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  if (flags.secure) parts.push("Secure");
  if (flags.domain) parts.push(`Domain=${flags.domain}`);
  const ma = flags.maxAgeSeconds ?? defaultMaxAgeSeconds;
  parts.push(`Max-Age=${ma}`);
  return parts.join("; ");
}

export function formatSessionCookie(
  sessionId: string,
  flags: CookieFlags,
): string {
  return formatCookie(
    SESSION_COOKIE_NAME,
    sessionId,
    flags,
    Math.floor(SESSION_TTL_MS / 1000),
  );
}

export function formatPendingCookie(
  state: string,
  flags: CookieFlags,
): string {
  return formatCookie(
    PENDING_COOKIE_NAME,
    state,
    flags,
    Math.floor(PENDING_TTL_MS / 1000),
  );
}

// formatClearSessionCookie — Max-Age=0 form. Browsers drop the cookie
// immediately; the empty value covers UAs that don't honor Max-Age=0
// on Set-Cookie alone.
export function formatClearSessionCookie(flags: CookieFlags): string {
  return formatCookie(SESSION_COOKIE_NAME, "", { ...flags, maxAgeSeconds: 0 }, 0);
}

export function formatClearPendingCookie(flags: CookieFlags): string {
  return formatCookie(PENDING_COOKIE_NAME, "", { ...flags, maxAgeSeconds: 0 }, 0);
}

// parseCookieHeader — pull one cookie value out of a "name=val;
// other=val" header. Returns null when absent or empty. Permissive
// (doesn't validate cookie syntax) since this is the receiving-end
// of a value we set ourselves.
export function parseCookieHeader(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) {
      const v = part.slice(eq + 1).trim();
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

export function readSessionCookie(header: string | undefined): string | null {
  return parseCookieHeader(header, SESSION_COOKIE_NAME);
}

export function readPendingCookie(header: string | undefined): string | null {
  return parseCookieHeader(header, PENDING_COOKIE_NAME);
}

// ── exports for tests ────────────────────────────────────────────────────────

export const _COOKIE_NAMES_TESTING = {
  session: SESSION_COOKIE_NAME,
  pending: PENDING_COOKIE_NAME,
};

export const _TTL_MS_TESTING = {
  session: SESSION_TTL_MS,
  pending: PENDING_TTL_MS,
};
