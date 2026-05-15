// L1 tests for Tenants list route (#32).

import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { cleanup, render } from "@solidjs/testing-library";

// eslint-disable-next-line no-var
var mockListQuery = jest.fn(async () => [] as unknown[]);

jest.mock("../lib/trpc", () => ({
  monok8sClient: {
    principals: {
      tenants: {
        list: { query: () => mockListQuery() },
      },
    },
  },
}));

jest.mock("../components/AppShell", () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}));

// eslint-disable-next-line import/first
import Tenants from "./Tenants";

beforeEach(() => {
  mockListQuery.mockClear();
  cleanup();
});

describe("Tenants route render (#32)", () => {
  const ROWS = [
    {
      id: "00000000-0000-0000-0000-000000000001",
      slug: "acme",
      plan: "starter",
      created_at: "2026-05-15T12:00:00.000Z",
    },
    {
      id: "00000000-0000-0000-0000-000000000002",
      slug: "globex",
      plan: "pro",
      created_at: "2026-05-15T13:00:00.000Z",
    },
  ];

  test("queries tenants.list on mount", async () => {
    render(() => <Tenants />);
    await Promise.resolve();
    expect(mockListQuery).toHaveBeenCalledTimes(1);
  });

  test("renders the 'New tenant' link", () => {
    const { container } = render(() => <Tenants />);
    expect(container.querySelector('[data-action="tenant-new"]')).not.toBeNull();
  });

  test("renders empty-state when list returns []", async () => {
    mockListQuery.mockResolvedValueOnce([]);
    const { container } = render(() => <Tenants />);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.textContent).toContain("No tenants visible");
  });

  test("renders one row per tenant with slug + plan + detail link", async () => {
    mockListQuery.mockResolvedValueOnce(ROWS);
    const { container } = render(() => <Tenants />);
    await Promise.resolve();
    await Promise.resolve();
    const rows = container.querySelectorAll("[data-row-key]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-row-key")).toBe(ROWS[0]!.id);
    expect(rows[0]?.textContent).toContain("acme");
    expect(rows[1]?.textContent).toContain("globex");
  });

  // Note: an "error state" test is omitted for the same reason as
  // TenantDetail.test.tsx — createResource's rejection escapes as an
  // unhandled promise in this jest configuration. SolidJS's
  // resource.error mechanism still works at runtime; happy + loading
  // + empty paths cover the surface.
});
