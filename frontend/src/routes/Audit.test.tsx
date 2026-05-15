// L1 unit tests for the Audit route — closes a documented gap from
// Discussion #45 ("Subscription wiring untested at L1"). Pattern
// mirrors Workflows.test.tsx: jest.mock("../lib/trpc", ...) replaces
// the workspace-package-importing module before the route's import
// runs.
//
// Audit.tsx has more surface than Workflows.tsx: an audit.list query
// for historical data AND an events.audit subscription for live tail.

import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { cleanup, render } from "@solidjs/testing-library";

// eslint-disable-next-line no-var
var mockCapturedOnData: ((evt: unknown) => void) | null = null;
// eslint-disable-next-line no-var
var mockCapturedOnError: ((err: Error) => void) | null = null;
// eslint-disable-next-line no-var
var mockCapturedListInput: unknown = null;
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
// eslint-disable-next-line no-var
var mockListQuery = jest.fn(async (input: unknown) => {
  mockCapturedListInput = input;
  return [];
});

jest.mock("../lib/trpc", () => ({
  monok8sClient: {
    audit: {
      list: { query: (input: unknown) => mockListQuery(input) },
    },
    events: {
      // Wrap in arrow so the access to mockSubscribe happens at call
      // time (after var declarations have been assigned), not at
      // factory time (when only the var-hoisted binding exists).
      audit: {
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

// AppShell renders the page chrome — mock it to a passthrough so the
// test focuses on the Audit-route subscription/query wiring.
jest.mock("../components/AppShell", () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}));

// eslint-disable-next-line import/first
import Audit from "./Audit";

beforeEach(() => {
  mockSubscribe.mockClear();
  mockUnsubscribe.mockClear();
  mockListQuery.mockClear();
  mockCapturedOnData = null;
  mockCapturedOnError = null;
  mockCapturedListInput = null;
  cleanup();
});

describe("Audit route subscription + query wiring (#107)", () => {
  test("subscribes to events.audit on mount with undefined input", () => {
    render(() => <Audit />);
    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    // Audit.tsx passes `undefined` as the input arg — tail every event.
    expect(mockSubscribe.mock.calls[0]![0]).toBeUndefined();
  });

  test("invokes audit.list query on mount with default page-size", async () => {
    render(() => <Audit />);
    // createResource fires asynchronously after mount.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockListQuery).toHaveBeenCalledTimes(1);
    const input = mockCapturedListInput as { before?: string; limit: number };
    expect(input.limit).toBe(50);
    expect(input.before).toBeUndefined();
  });

  test("onData callback pushes envelope into live tail (renders in DOM)", async () => {
    const { container } = render(() => <Audit />);
    await Promise.resolve();
    expect(mockCapturedOnData).not.toBeNull();

    mockCapturedOnData!({
      // Matches the AuditEnvelope shape from envelopeToUnified —
      // requires action + principal{id,type} + target{kind,id} +
      // timestamp + outcome (+ optional error / metadata).
      action: "user.suspended",
      principal: {
        id: "00000000-0000-0000-0000-0000000000bb",
        type: "user",
      },
      target: { kind: "user", id: "00000000-0000-0000-0000-0000000000cc" },
      timestamp: "2026-05-15T10:01:00.000Z",
      outcome: "success",
      tenantId: "00000000-0000-0000-0000-000000000001",
    });

    await Promise.resolve();
    expect(container.textContent).toContain("user.suspended");
  });

  test("onError callback sets the route's error signal surfaced by the view", async () => {
    const { container } = render(() => <Audit />);
    await Promise.resolve();
    expect(mockCapturedOnError).not.toBeNull();

    mockCapturedOnError!(new Error("SSE channel closed"));
    await Promise.resolve();
    expect(container.textContent).toMatch(/SSE channel closed/);
  });

  test("onCleanup triggers unsubscribe when the route unmounts", () => {
    const { unmount } = render(() => <Audit />);
    expect(mockUnsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
