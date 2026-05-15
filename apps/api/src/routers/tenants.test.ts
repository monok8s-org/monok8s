// L1 unit tests for tenantsRouter (#29). Tests:
//   - router shape (procedures exist under expected names)
//   - CreateTenantInputSchema invariants
//   - PingTenantInputSchema invariants

import { describe, expect, test } from "@jest/globals";

import {
  CreateTenantInputSchema,
  PingTenantInputSchema,
  tenantsRouter,
} from "./tenants.js";

describe("tenantsRouter shape", () => {
  test("exposes create + ping procedures", () => {
    expect(tenantsRouter).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const procs = (tenantsRouter as any)._def.procedures;
    expect(procs["create"]).toBeDefined();
    expect(procs["ping"]).toBeDefined();
  });
});

describe("CreateTenantInputSchema (#29)", () => {
  const VALID = {
    slug: "acme",
    plan: "starter" as const,
    ownerEmail: "alice@example.com",
  };

  test("accepts a valid input", () => {
    expect(CreateTenantInputSchema.safeParse(VALID).success).toBe(true);
  });

  test("accepts input without optional plan field", () => {
    const { plan: _plan, ...rest } = VALID;
    expect(CreateTenantInputSchema.safeParse(rest).success).toBe(true);
  });

  test("rejects slug too short (<3 chars)", () => {
    const r = CreateTenantInputSchema.safeParse({ ...VALID, slug: "ac" });
    expect(r.success).toBe(false);
  });

  test("rejects slug too long (>64 chars)", () => {
    const r = CreateTenantInputSchema.safeParse({
      ...VALID,
      slug: "a".repeat(65),
    });
    expect(r.success).toBe(false);
  });

  test("rejects slug with uppercase / underscore / special chars", () => {
    for (const bad of ["Acme", "ac_me", "ac.me", "ac me"]) {
      const r = CreateTenantInputSchema.safeParse({ ...VALID, slug: bad });
      expect(r.success).toBe(false);
    }
  });

  test("rejects invalid plan value", () => {
    const r = CreateTenantInputSchema.safeParse({
      ...VALID,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plan: "team" as any,
    });
    expect(r.success).toBe(false);
  });

  test("rejects invalid email", () => {
    const r = CreateTenantInputSchema.safeParse({
      ...VALID,
      ownerEmail: "not-an-email",
    });
    expect(r.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const r = CreateTenantInputSchema.safeParse({
      ...VALID,
      tenantId: "EVIL",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("PingTenantInputSchema (#29)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-000000000001";

  test("accepts a UUID id", () => {
    expect(PingTenantInputSchema.safeParse({ id: VALID_UUID }).success).toBe(
      true,
    );
  });

  test("rejects missing id", () => {
    expect(PingTenantInputSchema.safeParse({}).success).toBe(false);
  });

  test("rejects non-UUID id", () => {
    expect(
      PingTenantInputSchema.safeParse({ id: "not-a-uuid" }).success,
    ).toBe(false);
  });

  test("rejects smuggled extras via .strict()", () => {
    const r = PingTenantInputSchema.safeParse({
      id: VALID_UUID,
      tenantId: "EVIL",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});
