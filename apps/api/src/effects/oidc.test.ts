// L1 unit tests for effects/oidc.ts (#191 / #91 Phase B). Each effect
// takes the fetcher explicitly so tests pass a synthetic Response
// without any network mocking framework.

import { describe, expect, jest, test } from "@jest/globals";

import {
  buildAuthorizeUrl,
  discoverOidcConfig,
  exchangeCodeForToken,
} from "./oidc";

function stubFetcher(
  status: number,
  body: unknown,
  capturedInit?: { url?: string; init?: RequestInit },
): typeof fetch {
  return jest.fn(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (capturedInit) {
        capturedInit.url = typeof input === "string" ? input : input.toString();
        capturedInit.init = init;
      }
      return new Response(body === null ? "" : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    },
  ) as unknown as typeof fetch;
}

describe("buildAuthorizeUrl (pure)", () => {
  test("composes the canonical PKCE authorize URL", () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: "https://idp.test/authorize",
      clientId: "client-A",
      redirectUri: "https://app.test/cb",
      state: "STATE",
      codeChallenge: "CHALLENGE",
      scopes: ["openid", "email"],
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://idp.test/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client-A");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://app.test/cb");
    expect(parsed.searchParams.get("state")).toBe("STATE");
    expect(parsed.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("scope")).toBe("openid email");
  });
});

describe("discoverOidcConfig", () => {
  test("fetches and returns the OIDC discovery doc", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const doc = {
      issuer: "https://idp.test",
      authorization_endpoint: "https://idp.test/authorize",
      token_endpoint: "https://idp.test/token",
      jwks_uri: "https://idp.test/keys",
    };
    const result = await discoverOidcConfig(
      "https://idp.test/",
      stubFetcher(200, doc, captured),
    );
    expect(captured.url).toBe(
      "https://idp.test/.well-known/openid-configuration",
    );
    expect(result.token_endpoint).toBe("https://idp.test/token");
  });

  test("throws when the discovery doc misses a required field", async () => {
    const broken = { issuer: "https://idp.test" };
    await expect(
      discoverOidcConfig("https://idp.test", stubFetcher(200, broken)),
    ).rejects.toThrow(/missing required fields/);
  });

  test("throws on HTTP non-2xx", async () => {
    await expect(
      discoverOidcConfig("https://idp.test", stubFetcher(503, null)),
    ).rejects.toThrow(/returned 503/);
  });
});

describe("exchangeCodeForToken", () => {
  test("POSTs the form-encoded grant_type=authorization_code body", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const tokens = {
      access_token: "AT",
      id_token: "IDT",
      token_type: "Bearer",
      expires_in: 3600,
    };
    const result = await exchangeCodeForToken(
      {
        tokenEndpoint: "https://idp.test/token",
        code: "abc",
        codeVerifier: "VERIFIER",
        redirectUri: "https://app.test/cb",
        clientId: "client-A",
      },
      stubFetcher(200, tokens, captured),
    );
    expect(captured.url).toBe("https://idp.test/token");
    expect(captured.init?.method).toBe("POST");
    expect(captured.init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const body = new URLSearchParams(captured.init!.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("code_verifier")).toBe("VERIFIER");
    expect(body.get("redirect_uri")).toBe("https://app.test/cb");
    expect(body.get("client_id")).toBe("client-A");
    expect(body.get("client_secret")).toBeNull();
    expect(result.access_token).toBe("AT");
  });

  test("includes client_secret when set (confidential client)", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    await exchangeCodeForToken(
      {
        tokenEndpoint: "https://idp.test/token",
        code: "abc",
        codeVerifier: "V",
        redirectUri: "https://app.test/cb",
        clientId: "client-A",
        clientSecret: "shhhh",
      },
      stubFetcher(
        200,
        {
          access_token: "AT",
          id_token: "IDT",
          token_type: "Bearer",
          expires_in: 60,
        },
        captured,
      ),
    );
    const body = new URLSearchParams(captured.init!.body as string);
    expect(body.get("client_secret")).toBe("shhhh");
  });

  test("throws on token-endpoint non-2xx with truncated detail", async () => {
    await expect(
      exchangeCodeForToken(
        {
          tokenEndpoint: "https://idp.test/token",
          code: "abc",
          codeVerifier: "V",
          redirectUri: "https://app.test/cb",
          clientId: "client-A",
        },
        stubFetcher(400, { error: "invalid_grant" }),
      ),
    ).rejects.toThrow(/token exchange failed: 400/);
  });
});
