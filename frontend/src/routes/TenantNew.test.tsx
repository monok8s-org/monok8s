// L1 tests for TenantNew route + validateTenantNewForm helper (#32).
//
// jest.mock pattern from PR #260 — replace `../lib/trpc` + AppShell +
// @solidjs/router's useNavigate so the route renders + dispatches
// without network or routing.

import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

// eslint-disable-next-line no-var
var mockCreateMutate = jest.fn(async () => ({
  tenantId: "00000000-0000-0000-0000-000000000099",
  workflowId: "wf-id",
}));
// eslint-disable-next-line no-var
var mockNavigate = jest.fn();

jest.mock("../lib/trpc", () => ({
  monok8sClient: {
    principals: {
      tenants: {
        create: {
          mutate: (input: unknown) => mockCreateMutate(input),
        },
      },
    },
  },
}));

jest.mock("../components/AppShell", () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}));

jest.mock("@solidjs/router", () => ({
  useNavigate: () => mockNavigate,
}));

// eslint-disable-next-line import/first
import TenantNew, { validateTenantNewForm } from "./TenantNew";

beforeEach(() => {
  mockCreateMutate.mockClear();
  mockNavigate.mockClear();
  cleanup();
});

describe("validateTenantNewForm (#32)", () => {
  const OK = { slug: "acme", plan: "starter", ownerEmail: "alice@example.com" };

  test("accepts a valid input", () => {
    const r = validateTenantNewForm(OK);
    expect(r.ok).toBe(true);
  });

  test("trims slug + email whitespace before validating", () => {
    const r = validateTenantNewForm({
      slug: "  acme  ",
      plan: "starter",
      ownerEmail: "  alice@example.com  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slug).toBe("acme");
      expect(r.value.ownerEmail).toBe("alice@example.com");
    }
  });

  test("rejects slug shorter than 3 chars", () => {
    const r = validateTenantNewForm({ ...OK, slug: "ab" });
    expect(r.ok).toBe(false);
  });

  test("rejects slug longer than 64 chars", () => {
    const r = validateTenantNewForm({ ...OK, slug: "a".repeat(65) });
    expect(r.ok).toBe(false);
  });

  test("rejects slug with uppercase or underscore", () => {
    for (const bad of ["Acme", "ac_me", "ac.me"]) {
      expect(validateTenantNewForm({ ...OK, slug: bad }).ok).toBe(false);
    }
  });

  test("rejects invalid plan value", () => {
    expect(validateTenantNewForm({ ...OK, plan: "team" }).ok).toBe(false);
  });

  test("rejects invalid email", () => {
    expect(validateTenantNewForm({ ...OK, ownerEmail: "not-an-email" }).ok).toBe(false);
  });
});

describe("TenantNew route render (#32)", () => {
  test("renders form fields + submit button", () => {
    const { container } = render(() => <TenantNew />);
    expect(container.querySelector('[data-field="slug"]')).not.toBeNull();
    expect(container.querySelector('[data-field="plan"]')).not.toBeNull();
    expect(container.querySelector('[data-field="owner-email"]')).not.toBeNull();
    expect(
      container.querySelector('[data-action="submit-tenant-new"]'),
    ).not.toBeNull();
  });

  test("submit with valid input dispatches tenants.create.mutate + navigates to detail", async () => {
    const { container } = render(() => <TenantNew />);
    const slug = container.querySelector('[data-field="slug"]') as HTMLInputElement;
    const email = container.querySelector(
      '[data-field="owner-email"]',
    ) as HTMLInputElement;
    fireEvent.input(slug, { target: { value: "acme" } });
    fireEvent.input(email, { target: { value: "alice@example.com" } });
    fireEvent.click(
      container.querySelector('[data-action="submit-tenant-new"]')!,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockCreateMutate).toHaveBeenCalledTimes(1);
    expect(mockCreateMutate).toHaveBeenCalledWith({
      slug: "acme",
      plan: "starter",
      ownerEmail: "alice@example.com",
    });
    expect(mockNavigate).toHaveBeenCalledWith(
      "/tenants/00000000-0000-0000-0000-000000000099",
    );
  });

  test("submit with invalid slug surfaces client error + skips mutate", async () => {
    const { container } = render(() => <TenantNew />);
    const slug = container.querySelector('[data-field="slug"]') as HTMLInputElement;
    const email = container.querySelector(
      '[data-field="owner-email"]',
    ) as HTMLInputElement;
    fireEvent.input(slug, { target: { value: "AB" } }); // too short + uppercase
    fireEvent.input(email, { target: { value: "alice@example.com" } });
    fireEvent.click(
      container.querySelector('[data-action="submit-tenant-new"]')!,
    );
    await Promise.resolve();
    expect(mockCreateMutate).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  test("mutate rejection surfaces server error in role=alert", async () => {
    mockCreateMutate.mockRejectedValueOnce(
      new Error("FORBIDDEN: Only members of system:monok8s#create_tenants"),
    );
    const { container } = render(() => <TenantNew />);
    const slug = container.querySelector('[data-field="slug"]') as HTMLInputElement;
    const email = container.querySelector(
      '[data-field="owner-email"]',
    ) as HTMLInputElement;
    fireEvent.input(slug, { target: { value: "acme" } });
    fireEvent.input(email, { target: { value: "alice@example.com" } });
    fireEvent.click(
      container.querySelector('[data-action="submit-tenant-new"]')!,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNavigate).not.toHaveBeenCalled();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/FORBIDDEN/);
  });
});
