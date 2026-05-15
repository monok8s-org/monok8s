// L1 unit tests for the Workflows route — closes a documented gap
// from Discussion #45 ("Subscription wiring untested at L1; same
// posture as Audit.tsx + Workflows.tsx routes").
//
// Approach: jest.mock("../lib/trpc", ...) replaces the entire module
// with a stub before the route's import runs. This bypasses the
// session-59 wall (jest fails to resolve @monok8s/trpc through the
// workspace-package main field) — the real trpc.ts never loads, so
// its `import { createMonok8sClient } from "@monok8s/trpc"` is
// never evaluated. (#107)
//
// `var` declarations + `mock*` prefix are mandatory per jest's
// hoisting rules: jest.mock factory closures may only reference
// globals + variables whose names start with `mock`, and `var`
// hoists the declaration so the factory can close over it.

import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { cleanup, render } from "@solidjs/testing-library";

// eslint-disable-next-line no-var
var mockCapturedOnData: ((evt: unknown) => void) | null = null;
// eslint-disable-next-line no-var
var mockCapturedOnError: ((err: Error) => void) | null = null;
// eslint-disable-next-line no-var
var mockCapturedInput: unknown = null;
// eslint-disable-next-line no-var
var mockUnsubscribe = jest.fn();
// eslint-disable-next-line no-var
var mockSubscribe = jest.fn(
  (
    input: unknown,
    opts: {
      onData?: (evt: unknown) => void;
      onError?: (err: Error) => void;
    },
  ) => {
    mockCapturedInput = input;
    mockCapturedOnData = opts.onData ?? null;
    mockCapturedOnError = opts.onError ?? null;
    return { unsubscribe: mockUnsubscribe };
  },
);
// eslint-disable-next-line no-var
var mockUseAuth = jest.fn(() => ({
  user: () => ({
    id: "00000000-0000-0000-0000-0000000000aa",
    email: "test@example.com",
    name: "Test User",
    tenantId: "00000000-0000-0000-0000-000000000001",
    tenants: [{ id: "00000000-0000-0000-0000-000000000001", name: "acme" }],
    role: "admin",
  }),
  loading: () => false,
  error: () => null,
}));

jest.mock("../lib/trpc", () => ({
  monok8sClient: {
    events: {
      // Wrap in arrow so the access to mockSubscribe happens at call
      // time (after var declarations have been assigned), not at
      // factory time (when only the var-hoisted binding exists).
      workflow: {
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

jest.mock("../lib/auth", () => ({
  useAuth: () => mockUseAuth(),
  AuthProvider: ({ children }: { children: unknown }) => children,
}));

// AppShell renders the global chrome and itself imports
// @solidjs/router — mocking it to a passthrough keeps the test
// focused on the Workflows route's subscription wiring and avoids
// the router import's ESM resolution issue under jest.
jest.mock("../components/AppShell", () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}));

// Imports MUST follow jest.mock calls — jest hoists the mocks above
// the test file's other imports, but TS-side static-import order
// looks odd otherwise.
// eslint-disable-next-line import/first
import Workflows from "./Workflows";

beforeEach(() => {
  mockSubscribe.mockClear();
  mockUnsubscribe.mockClear();
  mockCapturedOnData = null;
  mockCapturedOnError = null;
  mockCapturedInput = null;
  cleanup();
});

describe("Workflows route subscription wiring (#107)", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const EXPECTED_WORKFLOW_ID = `tnt-${TENANT_ID}-phase-c-placeholder`;

  test("subscribes to events.workflow on mount with the tenant-prefixed placeholder workflowId", () => {
    render(() => <Workflows />);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockCapturedInput).toEqual({ workflowId: EXPECTED_WORKFLOW_ID });
  });

  test("onData callback pushes events into the timeline state (visible in render)", () => {
    const { container } = render(() => <Workflows />);
    expect(mockCapturedOnData).not.toBeNull();

    mockCapturedOnData!({
      workflow_id: EXPECTED_WORKFLOW_ID,
      step: "ProvisionNamespaceActivity",
      status: "completed",
      occurred_at: "2026-05-15T10:00:00.000Z",
    });

    expect(container.textContent).toContain("ProvisionNamespaceActivity");
  });

  test("onError callback updates error state surfaced via the timeline", () => {
    const { container } = render(() => <Workflows />);
    expect(mockCapturedOnError).not.toBeNull();

    mockCapturedOnError!(new Error("subscription closed unexpectedly"));

    expect(container.textContent).toMatch(/subscription closed unexpectedly/);
  });

  test("onCleanup triggers unsubscribe when the route unmounts", () => {
    const { unmount } = render(() => <Workflows />);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test("does not subscribe when auth user is absent (auth-gated)", () => {
    mockUseAuth.mockReturnValueOnce({
      user: () => null,
      loading: () => false,
      error: () => null,
    } as unknown as ReturnType<typeof mockUseAuth>);

    render(() => <Workflows />);
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});
