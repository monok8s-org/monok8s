// L1 unit tests for the auth seam (#193 + #191). Covers both the pure
// helpers (Phase A) and the Phase B OIDC flow against injected stub
// fetch + redirector. No real network; no jsdom navigation.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { render, renderHook, waitFor } from "@solidjs/testing-library";

import {
  AuthProvider,
  _setAuthFetcher_TESTING,
  _setAuthRedirector_TESTING,
  _testStubUser,
  defaultRouteForRole,
  useAuth,
} from "./auth";

afterEach(() => {
  _setAuthFetcher_TESTING(null);
  _setAuthRedirector_TESTING(null);
});

// Build a stub fetch that returns the given response when called.
// Records every URL the AuthProvider hit so tests can assert
// shape + count.
//
// jsdom doesn't ship the WHATWG `Response` constructor — Node has it
// globally but the jsdom env shadows globalThis. So we return a
// Response-shaped plain object covering the fields auth.tsx reads
// (`.ok`, `.status`, `.json()`, `.text()`).
function stubFetcher(opts: {
  status: number;
  body?: unknown;
  throwError?: Error;
}): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = jest.fn(async (input: Parameters<typeof fetch>[0]) => {
    calls.push(typeof input === "string" ? input : input.toString());
    if (opts.throwError) throw opts.throwError;
    return {
      ok: opts.status >= 200 && opts.status < 300,
      status: opts.status,
      json: async () => opts.body ?? null,
      text: async () => (opts.body ? JSON.stringify(opts.body) : ""),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const WIRE_USER = {
  userId: "00000000-0000-0000-0000-000000000aaa",
  name: "Real User",
  email: "real@monok8s.test",
  tenantId: "00000000-0000-0000-0000-000000000111",
  tenants: [
    { id: "00000000-0000-0000-0000-000000000111", name: "tenant-A" },
    { id: "00000000-0000-0000-0000-000000000222", name: "tenant-B" },
  ],
  role: "contributor" as const,
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("defaultRouteForRole (pure)", () => {
  test("admin → /dashboard", () => {
    expect(defaultRouteForRole("admin")).toBe("/dashboard");
  });

  test("contributor → /resources", () => {
    expect(defaultRouteForRole("contributor")).toBe("/resources");
  });

  test("viewer → /dashboard", () => {
    expect(defaultRouteForRole("viewer")).toBe("/dashboard");
  });
});

describe("_testStubUser", () => {
  test("returns the default stub user when called without args", () => {
    const user = _testStubUser();
    expect(user.role).toBe("admin");
    expect(user.email).toBe("dev@monok8s.test");
    expect(user.tenants).toHaveLength(2);
  });

  test("applies overrides on top of the default", () => {
    const user = _testStubUser({
      role: "contributor",
      name: "Override Name",
    });
    expect(user.role).toBe("contributor");
    expect(user.name).toBe("Override Name");
    expect(user.email).toBe("dev@monok8s.test");
  });
});

// ── AuthProvider + useAuth (Phase B real flow against stub fetch) ────────────

describe("AuthProvider + useAuth — authenticated (/me 200)", () => {
  test("populates user from /api/auth/me on mount", async () => {
    const { fetcher, calls } = stubFetcher({ status: 200, body: WIRE_USER });
    _setAuthFetcher_TESTING(fetcher);

    const { result } = renderHook(useAuth, {
      wrapper: (props) => <AuthProvider>{props.children}</AuthProvider>,
    });

    await waitFor(() => {
      expect(result.user()).not.toBeNull();
    });
    expect(result.loading()).toBe(false);
    expect(result.error()).toBeNull();
    expect(result.user()?.role).toBe("contributor");
    expect(result.user()?.email).toBe("real@monok8s.test");
    expect(calls).toEqual(["/api/auth/me"]);
  });

  test("switchTenant updates tenantId for a known tenant id", async () => {
    const { fetcher } = stubFetcher({ status: 200, body: WIRE_USER });
    _setAuthFetcher_TESTING(fetcher);

    const { result } = renderHook(useAuth, {
      wrapper: (props) => <AuthProvider>{props.children}</AuthProvider>,
    });

    await waitFor(() => {
      expect(result.user()).not.toBeNull();
    });

    const target = result.user()!.tenants[1]!.id;
    result.switchTenant(target);
    expect(result.user()?.tenantId).toBe(target);
  });

  test("switchTenant is a no-op for an unknown tenant id", async () => {
    const { fetcher } = stubFetcher({ status: 200, body: WIRE_USER });
    _setAuthFetcher_TESTING(fetcher);

    const { result } = renderHook(useAuth, {
      wrapper: (props) => <AuthProvider>{props.children}</AuthProvider>,
    });

    await waitFor(() => {
      expect(result.user()).not.toBeNull();
    });

    const before = result.user()!.tenantId;
    result.switchTenant("00000000-0000-0000-0000-deadbeefdead");
    expect(result.user()?.tenantId).toBe(before);
  });

  test("renders children inside the provider tree", () => {
    const { fetcher } = stubFetcher({ status: 200, body: WIRE_USER });
    _setAuthFetcher_TESTING(fetcher);

    const { getByText } = render(() => (
      <AuthProvider>
        <span>child-marker</span>
      </AuthProvider>
    ));
    expect(getByText("child-marker")).toBeTruthy();
  });
});

describe("AuthProvider + useAuth — unauthenticated (/me 401)", () => {
  test("redirects to /api/auth/login on 401", async () => {
    const { fetcher } = stubFetcher({ status: 401 });
    _setAuthFetcher_TESTING(fetcher);

    const redirects: string[] = [];
    _setAuthRedirector_TESTING((url) => redirects.push(url));

    renderHook(useAuth, {
      wrapper: (props) => <AuthProvider>{props.children}</AuthProvider>,
    });

    await waitFor(() => {
      expect(redirects.length).toBe(1);
    });
    // jsdom puts the page at http://localhost/ by default; returnTo
    // resolves to "/" — but the helper omits a returnTo equal to
    // the empty path, so the login URL has no query.
    expect(redirects[0]).toMatch(/^\/api\/auth\/login(\?returnTo=.+)?$/);
  });
});

describe("AuthProvider + useAuth — error paths", () => {
  test("surfaces non-401 non-ok response via error()", async () => {
    const { fetcher } = stubFetcher({ status: 503 });
    _setAuthFetcher_TESTING(fetcher);

    const { result } = renderHook(useAuth, {
      wrapper: (props) => <AuthProvider>{props.children}</AuthProvider>,
    });

    await waitFor(() => {
      expect(result.loading()).toBe(false);
    });
    expect(result.user()).toBeNull();
    expect(result.error()).toMatch(/503/);
  });

  test("surfaces fetch rejection via error()", async () => {
    const { fetcher } = stubFetcher({
      status: 0,
      throwError: new Error("network down"),
    });
    _setAuthFetcher_TESTING(fetcher);

    const { result } = renderHook(useAuth, {
      wrapper: (props) => <AuthProvider>{props.children}</AuthProvider>,
    });

    await waitFor(() => {
      expect(result.loading()).toBe(false);
    });
    expect(result.error()).toBe("network down");
  });
});
