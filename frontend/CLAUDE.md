# frontend/

SolidJS SPA. Hermetic Bazel builds via esbuild. Vite for local development only.

## Hermetic build rule — do not break this

Production and CI builds use Bazel + esbuild exclusively.
Vite is a local dev convenience and must never appear in the build graph.

```bash
# RIGHT — production build
bazel build //frontend:bundle

# WRONG — never in CI or Tekton
vite build
npx vite build
```

Do not add `vite` or any `vite-plugin-*` to any `BUILD.bazel` file.
Do not import Vite plugins from `esbuild.config.js`.
`vite.config.ts` exists for local dev only — it is not referenced by Bazel.

## Bazel macros
Use `solid_bundle()` and `solid_test()` from `//tools/bazel:solid.bzl`.
Never call `esbuild()` or `jest_test()` directly in frontend BUILD files.

```python
# RIGHT
load("//tools/bazel:solid.bzl", "solid_bundle", "solid_test")
solid_bundle(name = "bundle", entry_point = "src/index.tsx", srcs = [...])

# WRONG
load("@aspect_rules_esbuild//esbuild:defs.bzl", "esbuild")
esbuild(...)
```

## JSX transform
`babel-plugin-solid` handles the JSX transform for both Jest tests and esbuild builds.
`jsxImportSource = "solid-js"` in `tsconfig.json` is for IDE type checking only —
Babel owns the actual transform at build and test time.

## SolidJS reactivity conventions
- Wrap all state mutations in `act()` in tests — Solid batches updates synchronously
- Use signals for component-local state
- Use stores for shared/complex state — not signals passed as props
- Lazy-load routes with `lazy()` — all routes are code-split by default

## API calls
Use tRPC client from `packages/trpc`. Never call fetch() directly for API requests.
The tRPC client is configured once in `src/lib/trpc.ts` and imported everywhere.

## Auth flow (#191 / #91 Phase B)

The SPA is the public half of a BFF (Backend for Frontend) pattern. apps/api
owns the OIDC flow — the SPA never talks to Zitadel directly, never sees a
JWT, never holds a client secret.

```
SPA AuthProvider.onMount
  → GET /api/auth/me
    → 200 → populate user signal
    → 401 → window.location = /api/auth/login (apps/api handles)
    → other → error() signal set
```

`/api/auth/login` 302s to Zitadel's authorize endpoint with PKCE state
in a short-lived `monok8s_pending` cookie. Zitadel redirects back to
`/api/auth/callback?state=&code=`; apps/api exchanges the code for tokens,
verifies the access token via `packages/auth/verifyToken`, creates a
server-side session, and 302s to the SPA root with a `monok8s_session`
cookie.

### Session-cookie contract

- **Name:** `monok8s_session`
- **Value:** opaque 32-byte hex session ID (no JWT, no user data).
- **Attributes:** `HttpOnly` + `Secure` (in production / staging) +
  `SameSite=Lax` + `Path=/` + `Max-Age=28800` (8 hours).
- **Domain:** `MONOK8S_COOKIE_DOMAIN` env var sets the apex (e.g.
  `.monok8s.example.com`); empty → request host.
- **Pending cookie:** `monok8s_pending` carries the PKCE state value
  between `/login` redirect and `/callback`. 5-minute TTL.

The SPA never reads either cookie — `HttpOnly` makes them invisible to JS.
`fetch("/api/auth/me", { credentials: "include" })` is the only auth probe.

### Logout

`POST /api/auth/logout` clears `monok8s_session` and 302s to Zitadel's
end-session endpoint (when discovery exposes one). Browser lands back
at the SPA root unauthenticated → AuthProvider re-flow → /login.

### Test seams

- `_setAuthFetcher_TESTING(stub)` — inject a synthetic `fetch` for L1
  tests so AuthProvider exercises the real flow without a network.
- `_setAuthRedirector_TESTING(stub)` — record what URL would have been
  navigated to without mutating `window.location`.
- `_testStubUser(overrides?)` — compose synthetic `User` shapes in
  tests that don't need to exercise the fetch path.

### Phase B placeholders (resolved by sibling Issues)

- `name` comes from the JWT `name` claim today via apps/api's wire
  shaping — currently uses the email local-part as a placeholder.
- `role` is `"viewer"` for every authenticated user pending the
  SpiceDB role lookup (separate Issue).
- `tenants[]` is `[{ id: tenantId, name: "(active)" }]` pending the
  DB query that lists tenant memberships (separate Issue).
