// REST router for the OIDC BFF (#191 / #91 Phase B).
//
// Routes:
//   GET  /api/auth/login?returnTo=...    → 302 to Zitadel authorize
//   GET  /api/auth/callback?state=&code= → exchange code, set cookie, 302 returnTo
//   GET  /api/auth/me                    → 200 SpaWireUser JSON | 401
//   POST /api/auth/logout                → clear cookie, 302 end_session URL or /
//
// Mounted in apps/api/src/index.ts via middleware() pre-handler, same
// pattern as routers/system.ts. The handlers themselves live in
// handlers/auth.ts + handlers/sessions.ts so they're plain-call-testable
// (per code-design.md Rule 11 no_buried_chains).

import type http from "node:http";

import { getConfig } from "../config.js";
import {
  buildEndSessionUrl,
  handleCallback,
  handleLogin,
  shapeWireUser,
  type OidcConfigSnapshot,
} from "../handlers/auth.js";
import {
  deleteSession,
  formatClearPendingCookie,
  formatClearSessionCookie,
  formatPendingCookie,
  formatSessionCookie,
  lookupSession,
  readPendingCookie,
  readSessionCookie,
  type CookieFlags,
} from "../handlers/sessions.js";

function cookieFlagsFromConfig(): CookieFlags {
  const cfg = getConfig();
  return { secure: cfg.cookieSecure, domain: cfg.cookieDomain };
}

function oidcConfigSnapshotFromAppConfig(): OidcConfigSnapshot | null {
  const cfg = getConfig();
  if (
    !cfg.zitadelIssuer ||
    !cfg.zitadelClientId ||
    !cfg.zitadelRedirectUri
  ) {
    return null;
  }
  return {
    issuer: cfg.zitadelIssuer,
    clientId: cfg.zitadelClientId,
    redirectUri: cfg.zitadelRedirectUri,
    scopes: [],
  };
}

function send(
  res: http.ServerResponse,
  status: number,
  body: string | object,
  extraHeaders: Record<string, string | string[]> = {},
): void {
  const isString = typeof body === "string";
  const payload = isString ? body : JSON.stringify(body);
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": isString ? "text/plain" : "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(payload);
}

function notConfigured(res: http.ServerResponse): void {
  send(res, 503, { error: "oidc_not_configured" });
}

// ── GET /api/auth/login ──────────────────────────────────────────────────────

async function routeLogin(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const cfg = oidcConfigSnapshotFromAppConfig();
  if (!cfg) return notConfigured(res);

  const returnTo = url.searchParams.get("returnTo") ?? undefined;
  const result = await handleLogin(cfg, { returnTo });

  res.writeHead(302, {
    Location: result.authorizeUrl,
    "Set-Cookie": formatPendingCookie(result.state, cookieFlagsFromConfig()),
  });
  res.end();
}

// ── GET /api/auth/callback ───────────────────────────────────────────────────

async function routeCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const cfg = oidcConfigSnapshotFromAppConfig();
  if (!cfg) return notConfigured(res);

  const stateFromQuery = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) {
    return send(res, 400, { error: "oidc_error", detail: error });
  }
  if (!stateFromQuery || !code) {
    return send(res, 400, { error: "missing_state_or_code" });
  }

  const stateFromCookie = readPendingCookie(req.headers.cookie);
  const flags = cookieFlagsFromConfig();

  let result;
  try {
    result = await handleCallback({
      config: cfg,
      stateFromQuery,
      stateFromCookie,
      code,
    });
  } catch (e) {
    // Clear pending cookie on any failure so the client isn't stuck
    // with a stale state value.
    res.writeHead(400, {
      "Content-Type": "application/json",
      "Set-Cookie": formatClearPendingCookie(flags),
    });
    res.end(
      JSON.stringify({
        error: "callback_failed",
        detail: e instanceof Error ? e.message : String(e),
      }),
    );
    return;
  }

  res.writeHead(302, {
    Location: result.returnTo,
    "Set-Cookie": [
      formatSessionCookie(result.sessionId, flags),
      formatClearPendingCookie(flags),
    ],
  });
  res.end();
}

// ── GET /api/auth/me ─────────────────────────────────────────────────────────

function routeMe(req: http.IncomingMessage, res: http.ServerResponse): void {
  const sessionId = readSessionCookie(req.headers.cookie);
  const session = lookupSession(sessionId);
  if (!session) return send(res, 401, { error: "unauthenticated" });
  return send(res, 200, shapeWireUser(session.user));
}

// ── POST /api/auth/logout ────────────────────────────────────────────────────

async function routeLogout(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const sessionId = readSessionCookie(req.headers.cookie);
  deleteSession(sessionId);

  const cfg = oidcConfigSnapshotFromAppConfig();
  const flags = cookieFlagsFromConfig();
  let endSession: string | null = null;
  if (cfg) {
    try {
      // Post-logout redirect lands the user back at the app root.
      // Caller's host comes from request — use the protocol + host
      // headers since the proxy may rewrite (Cloudflare → Cilium →
      // api). Fall back to "/" if those are missing.
      const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
      const host = req.headers["x-forwarded-host"] ?? req.headers.host;
      const origin = host ? `${proto}://${host}` : "";
      endSession = await buildEndSessionUrl(cfg, `${origin}/`);
    } catch {
      // Discovery / end_session unavailable → fall through to local
      // cookie clear without redirecting upstream.
      endSession = null;
    }
  }

  const clearCookie = formatClearSessionCookie(flags);
  if (endSession) {
    res.writeHead(302, { Location: endSession, "Set-Cookie": clearCookie });
    res.end();
    return;
  }
  res.writeHead(204, { "Set-Cookie": clearCookie });
  res.end();
}

// ── exported entrypoint ──────────────────────────────────────────────────────
//
// Mount in apps/api/src/index.ts before the tRPC handler. Returns
// true when this router handled the request.

export function handleAuthRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!req.url || !req.url.startsWith("/api/auth/")) return false;
  // URL needs a base for parsing relative URLs.
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  switch (url.pathname) {
    case "/api/auth/login":
      if (req.method !== "GET") {
        send(res, 405, { error: "method_not_allowed" });
        return true;
      }
      void routeLogin(req, res, url).catch((e) => {
        send(res, 500, {
          error: "login_failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      });
      return true;

    case "/api/auth/callback":
      if (req.method !== "GET") {
        send(res, 405, { error: "method_not_allowed" });
        return true;
      }
      void routeCallback(req, res, url).catch((e) => {
        send(res, 500, {
          error: "callback_failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      });
      return true;

    case "/api/auth/me":
      if (req.method !== "GET") {
        send(res, 405, { error: "method_not_allowed" });
        return true;
      }
      routeMe(req, res);
      return true;

    case "/api/auth/logout":
      if (req.method !== "POST") {
        send(res, 405, { error: "method_not_allowed" });
        return true;
      }
      void routeLogout(req, res).catch((e) => {
        send(res, 500, {
          error: "logout_failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      });
      return true;

    default:
      send(res, 404, { error: "not_found" });
      return true;
  }
}
