// L1 unit tests for handlers/auth.ts (#191 / #91 Phase B).
//
// handleLogin + handleCallback compose effects/oidc.ts + sessions.ts +
// verifyToken — all replaced with synthetic fixtures here so the tests
// are pure logic. Discovery cache cleared per test so stubbed
// discovery docs don't bleed across cases.

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

import type { VerifiedUser } from "@monok8s/auth";

import {
  _clearDiscoveryCache_TESTING,
  buildEndSessionUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  handleCallback,
  handleLogin,
  shapeWireUser,
  type OidcConfigSnapshot,
} from "./auth";
import { _setStore_TESTING } from "./sessions";

const DISCOVERY = {
  issuer: "https://zitadel.test",
  authorization_endpoint: "https://zitadel.test/oauth/v2/authorize",
  token_endpoint: "https://zitadel.test/oauth/v2/token",
  end_session_endpoint: "https://zitadel.test/oidc/v1/end_session",
  jwks_uri: "https://zitadel.test/oauth/v2/keys",
};

const CONFIG: OidcConfigSnapshot = {
  issuer: "https://zitadel.test",
  clientId: "spa-client",
  redirectUri: "https://app.test/auth/callback",
  scopes: [],
};

beforeEach(() => {
  _clearDiscoveryCache_TESTING();
  _setStore_TESTING({ sessions: null, pending: null });
});

afterEach(() => {
  _clearDiscoveryCache_TESTING();
  _setStore_TESTING({ sessions: null, pending: null });
});

function discoveryFetcher(): typeof fetch {
  return jest.fn(async () => new Response(JSON.stringify(DISCOVERY), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as unknown as typeof fetch;
}

// ── PKCE primitives ──────────────────────────────────────────────────────────

describe("PKCE primitives", () => {
  test("generateCodeVerifier produces base64url chars", () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(v.length).toBeGreaterThanOrEqual(43);
  });

  test("deriveCodeChallenge is deterministic for a verifier", () => {
    const v = "fixed-verifier-value-1234567890abcdefghij";
    const c1 = deriveCodeChallenge(v);
    const c2 = deriveCodeChallenge(v);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("generateState yields a base64url token", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ── handleLogin ──────────────────────────────────────────────────────────────

describe("handleLogin", () => {
  test("returns authorize URL with PKCE + state + scopes", async () => {
    const fetcher = discoveryFetcher();
    const result = await handleLogin(CONFIG, { fetcher });
    expect(result.authorizeUrl).toMatch(
      /^https:\/\/zitadel\.test\/oauth\/v2\/authorize\?/,
    );
    const url = new URL(result.authorizeUrl);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("spa-client");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get("scope")).toBe("openid profile email");
  });

  test("each invocation yields a fresh state value", async () => {
    const fetcher = discoveryFetcher();
    const a = await handleLogin(CONFIG, { fetcher });
    const b = await handleLogin(CONFIG, { fetcher });
    expect(a.state).not.toBe(b.state);
  });
});

// ── handleCallback ───────────────────────────────────────────────────────────

describe("handleCallback", () => {
  test("rejects when state cookie doesn't match query", async () => {
    const fetcher = discoveryFetcher();
    await expect(
      handleCallback({
        config: CONFIG,
        stateFromQuery: "abc",
        stateFromCookie: "different",
        code: "code-xyz",
        fetcher,
      }),
    ).rejects.toThrow(/CSRF check failed/);
  });

  test("rejects when state cookie is missing", async () => {
    const fetcher = discoveryFetcher();
    await expect(
      handleCallback({
        config: CONFIG,
        stateFromQuery: "abc",
        stateFromCookie: null,
        code: "code-xyz",
        fetcher,
      }),
    ).rejects.toThrow(/CSRF check failed/);
  });

  test("rejects when pending auth not registered (or expired)", async () => {
    const fetcher = discoveryFetcher();
    await expect(
      handleCallback({
        config: CONFIG,
        stateFromQuery: "unknown-state",
        stateFromCookie: "unknown-state",
        code: "code-xyz",
        fetcher,
      }),
    ).rejects.toThrow(/Pending auth not found/);
  });

  test("happy path: exchanges code + verifies token + creates session", async () => {
    // First handleLogin to register pending state with a real verifier.
    const fetcher = jest.fn(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes(".well-known/openid-configuration")) {
          return new Response(JSON.stringify(DISCOVERY), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url === DISCOVERY.token_endpoint && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              access_token: "ACCESS",
              id_token: "ID",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        throw new Error(`unexpected URL ${url}`);
      },
    ) as unknown as typeof fetch;

    const login = await handleLogin(CONFIG, { fetcher });

    const verifier = jest.fn(
      async (_token: string): Promise<VerifiedUser> => ({
        userId: "user-1",
        zitadelId: "z-1",
        tenantId: "tenant-1",
        email: "user@monok8s.test",
      }),
    );

    const result = await handleCallback({
      config: CONFIG,
      stateFromQuery: login.state,
      stateFromCookie: login.state,
      code: "code-from-zitadel",
      fetcher,
      verifier,
    });

    expect(result.sessionId).toHaveLength(64);
    expect(result.returnTo).toBe("/");
    expect(verifier).toHaveBeenCalledWith("ACCESS");
  });
});

// ── shapeWireUser ────────────────────────────────────────────────────────────

describe("shapeWireUser", () => {
  test("maps VerifiedUser to SpaWireUser with placeholder role + tenants", () => {
    const wire = shapeWireUser({
      userId: "u-1",
      zitadelId: "z-1",
      tenantId: "t-1",
      email: "alex@example.com",
    });
    expect(wire.userId).toBe("u-1");
    expect(wire.email).toBe("alex@example.com");
    expect(wire.name).toBe("alex"); // email local-part placeholder
    expect(wire.tenantId).toBe("t-1");
    expect(wire.tenants).toEqual([{ id: "t-1", name: "(active)" }]);
    expect(wire.role).toBe("viewer");
  });
});

// ── buildEndSessionUrl ───────────────────────────────────────────────────────

describe("buildEndSessionUrl", () => {
  test("returns Zitadel end_session URL with client_id + redirect", async () => {
    const fetcher = discoveryFetcher();
    const url = await buildEndSessionUrl(
      CONFIG,
      "https://app.test/",
      fetcher,
    );
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin + parsed.pathname).toBe(DISCOVERY.end_session_endpoint);
    expect(parsed.searchParams.get("client_id")).toBe("spa-client");
    expect(parsed.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.test/",
    );
  });

  test("returns null when discovery has no end_session_endpoint", async () => {
    _clearDiscoveryCache_TESTING();
    const fetcher = jest.fn(
      async () =>
        new Response(
          JSON.stringify({ ...DISCOVERY, end_session_endpoint: undefined }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;
    const url = await buildEndSessionUrl(CONFIG, "https://app.test/", fetcher);
    expect(url).toBeNull();
  });
});
