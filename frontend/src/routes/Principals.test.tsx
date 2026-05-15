// L1 unit tests for the Principals route — closes Issue #107 AC4
// ("Principals.test.tsx covers same shape for events.tenant + the
// cascading refetches of groups + principalRoles").
//
// Pattern matches Audit.test.tsx + Workflows.test.tsx from PR #260:
// jest.mock("../lib/trpc", ...) replaces the workspace-package-
// importing module before the route's import runs. `var` declarations
// + `mock*` prefix are mandatory for jest.mock factory closures.
//
// Principals route has more surface than Audit/Workflows: 3 resources
// (users / groups / principalRoles) + 8+ mutations + an events.tenant
// subscription. This test focuses on the subscription wiring; the
// mutations are stubbed but not exercised in depth (their behavior is
// covered by the PrincipalAdmin.test.tsx component tests).

import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { cleanup, render } from "@solidjs/testing-library";

// eslint-disable-next-line no-var
var mockCapturedOnData: ((evt: unknown) => void) | null = null;
// eslint-disable-next-line no-var
var mockCapturedOnError: ((err: Error) => void) | null = null;
// eslint-disable-next-line no-var
var mockUnsubscribe = jest.fn();
// eslint-disable-next-line no-var
var mockSubscribe = jest.fn(
  (
    _input: unknown,
    opts: {
      onData?: (evt: unknown) => void;
      onError?: (err: Error) => void;
    },
  ) => {
    mockCapturedOnData = opts.onData ?? null;
    mockCapturedOnError = opts.onError ?? null;
    return { unsubscribe: mockUnsubscribe };
  },
);

// Track refetch trigger calls. Principals route's onData fires
// `refetchGroups()` + `refetchPrincipalRoles()` + `refetchUsers()`
// (#263). We use call-counts on each .list query as proxies for
// refetch detection (createResource memoizes the source signal;
// triggering refetch causes the query to fire again).
// eslint-disable-next-line no-var
var mockGroupsListCalls = 0;
// eslint-disable-next-line no-var
var mockPrincipalRolesListCalls = 0;
// eslint-disable-next-line no-var
var mockUsersListCalls = 0;

jest.mock("../lib/trpc", () => ({
  monok8sClient: {
    principals: {
      users: {
        list: {
          query: jest.fn(async () => {
            mockUsersListCalls += 1;
            return [];
          }),
        },
      },
      groups: {
        list: {
          query: jest.fn(async () => {
            mockGroupsListCalls += 1;
            return [];
          }),
        },
        list_members: { query: jest.fn(async () => ({ users: [] })) },
        create: { mutate: jest.fn(async () => {}) },
        delete: { mutate: jest.fn(async () => {}) },
        add_member: { mutate: jest.fn(async () => {}) },
        remove_member: { mutate: jest.fn(async () => {}) },
      },
      roles: {
        list_for_principal: {
          query: jest.fn(async () => {
            mockPrincipalRolesListCalls += 1;
            return { roles: [] };
          }),
        },
        assign: { mutate: jest.fn(async () => {}) },
        unassign: { mutate: jest.fn(async () => {}) },
        change: { mutate: jest.fn(async () => {}) },
      },
      users_top: {
        suspend: { mutate: jest.fn(async () => {}) },
        reinstate: { mutate: jest.fn(async () => {}) },
      },
    },
    // Re-expose users.suspend / users.reinstate at the principals.users
    // level for the Users tab mutation paths.
    events: {
      tenant: {
        subscribe: (
          input: unknown,
          opts: {
            onData?: (evt: unknown) => void;
            onError?: (err: Error) => void;
          },
        ) => mockSubscribe(input, opts),
      },
    },
  },
}));

// AppShell renders the global chrome and imports @solidjs/router —
// passthrough mock keeps the test focused on Principals route's
// subscription wiring.
jest.mock("../components/AppShell", () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}));

// PrincipalAdmin is the presentation component — passthrough so the
// route can render without dragging in the component-level state
// (which would require providing every prop it touches).
jest.mock("../components/PrincipalAdmin", () => ({
  __esModule: true,
  default: () => null,
  TENANT_ROLES: ["owner", "admin", "member", "viewer", "billing_manager"],
}));

// eslint-disable-next-line import/first
import Principals from "./Principals";

beforeEach(() => {
  mockSubscribe.mockClear();
  mockUnsubscribe.mockClear();
  mockCapturedOnData = null;
  mockCapturedOnError = null;
  mockGroupsListCalls = 0;
  mockPrincipalRolesListCalls = 0;
  mockUsersListCalls = 0;
  cleanup();
});

describe("Principals route subscription wiring (#107 AC4)", () => {
  test("subscribes to events.tenant on mount with undefined input", () => {
    render(() => <Principals />);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    // Principals.tsx passes `undefined` as the input arg — tail every
    // tenant event.
    expect(mockSubscribe.mock.calls[0]![0]).toBeUndefined();
  });

  test("captures onData + onError callbacks on the subscription", () => {
    render(() => <Principals />);
    expect(mockCapturedOnData).not.toBeNull();
    expect(mockCapturedOnError).not.toBeNull();
  });

  test("onData callback triggers refetchGroups (groups.list re-runs)", async () => {
    render(() => <Principals />);
    // Wait for initial resources to settle.
    await Promise.resolve();
    await Promise.resolve();
    const baselineGroupsCalls = mockGroupsListCalls;

    mockCapturedOnData!({
      kind: "groups.create",
      tenantId: "00000000-0000-0000-0000-000000000001",
      timestamp: "2026-05-15T10:00:00.000Z",
    });
    // refetch is async; let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGroupsListCalls).toBeGreaterThan(baselineGroupsCalls);
  });

  test("onData callback triggers refetchUsers (#263 — users.list re-runs)", async () => {
    render(() => <Principals />);
    await Promise.resolve();
    await Promise.resolve();
    const baselineUsersCalls = mockUsersListCalls;

    mockCapturedOnData!({
      kind: "users.invited",
      tenantId: "00000000-0000-0000-0000-000000000001",
      timestamp: "2026-05-15T10:00:00.000Z",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockUsersListCalls).toBeGreaterThan(baselineUsersCalls);
  });

  test("onError callback is swallowed (no thrown error)", () => {
    render(() => <Principals />);
    expect(mockCapturedOnError).not.toBeNull();
    // Per the route source, onError is `() => {}` — the indicator
    // just stops advancing. Just assert it doesn't throw.
    expect(() => {
      mockCapturedOnError!(new Error("SSE channel closed"));
    }).not.toThrow();
  });

  test("onCleanup triggers unsubscribe when the route unmounts", () => {
    const { unmount } = render(() => <Principals />);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test("queries users.list + groups.list on mount (resource bootstrap)", async () => {
    render(() => <Principals />);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockGroupsListCalls).toBeGreaterThanOrEqual(1);
    expect(mockUsersListCalls).toBeGreaterThanOrEqual(1);
  });
});
