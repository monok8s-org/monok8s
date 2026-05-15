// IO effect functions for the Zitadel OIDC authorization-code-with-PKCE
// flow (#191 / #91 Phase B). Each function is a named effect at a single
// boundary — no caller resolves URLs from env vars; all inputs are
// explicit. Per code-design.md Rule 2 effect_then_interceptor: the
// network calls live behind well-named functions that handlers compose;
// the handlers don't inline fetch().

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  jwks_uri: string;
}

export interface OidcTokens {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

// discoverOidcConfig — fetch the OIDC discovery document.
//
// Lives behind an injectable fetcher so L1 tests pass a stub
// function instead of monkey-patching globalThis.fetch.
export async function discoverOidcConfig(
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetcher(url);
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed: GET ${url} returned ${res.status}`,
    );
  }
  const body = (await res.json()) as Partial<OidcDiscovery>;
  if (!body.authorization_endpoint || !body.token_endpoint || !body.jwks_uri) {
    throw new Error(
      `OIDC discovery response missing required fields at ${url}`,
    );
  }
  return body as OidcDiscovery;
}

export interface ExchangeCodeForTokenArgs {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  // Optional — only set when registering the SPA as a confidential
  // client. PKCE public clients omit this. Either flow works; the
  // BFF chooses one at Zitadel registration time.
  clientSecret?: string;
}

// exchangeCodeForToken — POST to the token endpoint with the
// authorization code + PKCE verifier, return tokens. Single
// well-named effect at the network boundary.
export async function exchangeCodeForToken(
  args: ExchangeCodeForTokenArgs,
  fetcher: typeof fetch = fetch,
): Promise<OidcTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
  });
  if (args.clientSecret) {
    body.set("client_secret", args.clientSecret);
  }
  const res = await fetcher(args.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OIDC token exchange failed: ${res.status} ${detail.slice(0, 200)}`,
    );
  }
  return (await res.json()) as OidcTokens;
}

export interface AuthorizeUrlArgs {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
}

// buildAuthorizeUrl — pure URL builder. No IO. Composes the
// authorization-endpoint URL with the required query params for
// authorization-code + PKCE.
export function buildAuthorizeUrl(args: AuthorizeUrlArgs): string {
  const url = new URL(args.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", args.scopes.join(" "));
  return url.toString();
}
