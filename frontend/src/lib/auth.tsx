// Auth context + provider (#91 Phase A + Phase B).
//
// Phase A shipped a STUB AuthProvider that returned a hardcoded test
// user. Phase B (#191) replaces the stub with the real Zitadel OIDC
// flow via apps/api's BFF endpoints:
//
//   - AuthProvider.onMount fetches GET /api/auth/me
//   - 200 → populate `user` signal from the SpaWireUser response
//   - 401 → redirect to GET /api/auth/login (apps/api 302s to Zitadel)
//   - error → surface via `error()` signal
//
// The public API stays the same: `useAuth().user / loading /
// switchTenant`, the `User` type, `defaultRouteForRole`. Phase A's
// route handlers don't change.
//
// `_setAuthFetcher_TESTING` + `_setAuthRedirector_TESTING` keep L1
// tests plain-call-testable without a real network or jsdom
// navigation: tests inject a stub fetch + redirector and AuthProvider
// exercises the real flow against them.

import {
  createContext,
  createSignal,
  onMount,
  useContext,
  type Component,
  type JSX,
} from "solid-js";

export type Role = "admin" | "contributor" | "viewer";

export interface User {
  userId: string;
  name: string;
  email: string;
  tenantId: string;
  tenants: { id: string; name: string }[];
  role: Role;
}

export interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

export interface AuthApi {
  user: () => User | null;
  loading: () => boolean;
  error: () => string | null;
  switchTenant: (tenantId: string) => void;
}

const AuthContext = createContext<AuthApi>();

// Stub user — kept for L1 tests (via `_testStubUser`). Production
// code paths no longer touch this constant; it's a fixture.
const STUB_USER: User = {
  userId: "00000000-0000-0000-0000-000000000001",
  name: "Dev User",
  email: "dev@monok8s.test",
  tenantId: "00000000-0000-0000-0000-000000000001",
  tenants: [
    { id: "00000000-0000-0000-0000-000000000001", name: "acme" },
    { id: "00000000-0000-0000-0000-000000000002", name: "globex" },
  ],
  role: "admin",
};

// Fetcher seam. L1 tests inject a stub fetch that returns synthetic
// responses without hitting the network.
type Fetcher = typeof fetch;
let fetcher: Fetcher | null = null;

export function _setAuthFetcher_TESTING(f: Fetcher | null): void {
  fetcher = f;
}

function currentFetcher(): Fetcher {
  return fetcher ?? globalThis.fetch.bind(globalThis);
}

// Redirect seam. L1 tests record the URL we would have navigated to
// without actually mutating the jsdom window.location.
type Redirector = (url: string) => void;
let redirector: Redirector | null = null;

export function _setAuthRedirector_TESTING(r: Redirector | null): void {
  redirector = r;
}

function currentRedirector(): Redirector {
  return (
    redirector ??
    ((url: string) => {
      if (typeof window !== "undefined") {
        window.location.href = url;
      }
    })
  );
}

// Wire shape — what GET /api/auth/me returns (mirrors apps/api's
// SpaWireUser). Type-only; the runtime check is `res.ok`.
interface SpaWireUser {
  userId: string;
  name: string;
  email: string;
  tenantId: string;
  tenants: { id: string; name: string }[];
  role: Role;
}

function returnToFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const { pathname, search, hash } = window.location;
  // Don't echo /auth/* paths back as returnTo — those are the
  // redirect chain itself.
  if (pathname.startsWith("/auth/")) return undefined;
  return `${pathname}${search}${hash}` || undefined;
}

function buildLoginUrl(returnTo: string | undefined): string {
  if (!returnTo) return "/api/auth/login";
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export const AuthProvider: Component<{ children: JSX.Element }> = (props) => {
  const [user, setUser] = createSignal<User | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    void (async () => {
      try {
        const res = await currentFetcher()("/api/auth/me", {
          credentials: "include",
        });
        if (res.status === 401) {
          currentRedirector()(buildLoginUrl(returnToFromLocation()));
          return;
        }
        if (!res.ok) {
          setError(`auth /me responded ${res.status}`);
          setLoading(false);
          return;
        }
        const wire = (await res.json()) as SpaWireUser;
        setUser(wire);
        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();
  });

  const switchTenant = (tenantId: string) => {
    const current = user();
    if (current && current.tenants.some((t) => t.id === tenantId)) {
      setUser({ ...current, tenantId });
    }
  };

  const api: AuthApi = {
    user,
    loading,
    error,
    switchTenant,
  };

  return (
    <AuthContext.Provider value={api}>{props.children}</AuthContext.Provider>
  );
};

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth() called outside <AuthProvider>");
  }
  return ctx;
}

// Role → default-route mapping. Pure function so the redirect logic
// is testable in isolation.
export function defaultRouteForRole(role: Role): string {
  switch (role) {
    case "admin":
      return "/dashboard";
    case "contributor":
      return "/resources";
    case "viewer":
      return "/dashboard";
  }
}

// Test seam — L1 tests compose synthetic users without going through
// onMount + fetch.
export function _testStubUser(overrides?: Partial<User>): User {
  return { ...STUB_USER, ...overrides };
}
