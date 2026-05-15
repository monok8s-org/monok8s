// L1 unit tests for apps/api/src/routers/grants.ts (#224 / #91 local).
//
// Schema validation + router shape. The procedure body itself is a
// thin wrapper over createTemporaryGrant (tested separately in
// handlers/grants.test.ts) — these cases pin the wire-boundary
// invariants: which inputs the schema accepts, which it rejects.

import { describe, expect, test } from "@jest/globals";

import {
  CreateTemporaryGrantSchema,
  GetGrantInputSchema,
  RevokeTemporaryGrantSchema,
  UpdateGrantReasonInputSchema,
  grantsRouter,
} from "./grants.js";

describe("grantsRouter shape", () => {
  test("loads cleanly + exposes list / get / create_temporary / revoke / update_reason procedures", () => {
    expect(grantsRouter).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const procs = (grantsRouter as any)._def.procedures;
    expect(procs).toBeDefined();
    expect(procs["list"]).toBeDefined();
    expect(procs["get"]).toBeDefined();
    expect(procs["create_temporary"]).toBeDefined();
    expect(procs["revoke"]).toBeDefined();
    expect(procs["update_reason"]).toBeDefined();
  });
});

describe("CreateTemporaryGrantSchema (#224)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-000000000099";

  test("accepts minimal valid input (admin grant for 1h)", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
    });
    expect(result.success).toBe(true);
  });

  test("accepts each grantable role", () => {
    for (const role of ["admin", "member", "viewer", "billing_manager"]) {
      const result = CreateTemporaryGrantSchema.safeParse({
        subjectId: VALID_UUID,
        subjectType: "user",
        role,
        durationSeconds: 3600,
      });
      expect(result.success).toBe(true);
    }
  });

  test("accepts service_account subjectType", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "service_account",
      role: "admin",
      durationSeconds: 3600,
    });
    expect(result.success).toBe(true);
  });

  test("accepts optional reason within length cap", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
      reason: "incident response — escalation #4271",
    });
    expect(result.success).toBe(true);
  });

  test("rejects role=owner (excluded by enum)", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "owner",
      durationSeconds: 3600,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["role"]);
    }
  });

  test("rejects unknown role string", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "superuser",
      durationSeconds: 3600,
    });
    expect(result.success).toBe(false);
  });

  test("rejects zero duration", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 0,
    });
    expect(result.success).toBe(false);
  });

  test("rejects negative duration", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: -1,
    });
    expect(result.success).toBe(false);
  });

  test("rejects duration above 24h cap", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 24 * 60 * 60 + 1,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["durationSeconds"]);
    }
  });

  test("rejects fractional duration", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600.5,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID subjectId", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: "not-a-uuid",
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["subjectId"]);
    }
  });

  test("rejects unknown subjectType", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "group",
      role: "admin",
      durationSeconds: 3600,
    });
    expect(result.success).toBe(false);
  });

  test("rejects reason exceeding 256 chars", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
      reason: "x".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId field via .strict()", () => {
    const result = CreateTemporaryGrantSchema.safeParse({
      subjectId: VALID_UUID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("RevokeTemporaryGrantSchema (#226)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts a UUID grantId", () => {
    const result = RevokeTemporaryGrantSchema.safeParse({ grantId: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects missing grantId", () => {
    const result = RevokeTemporaryGrantSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["grantId"]);
    }
  });

  test("rejects non-UUID grantId", () => {
    const result = RevokeTemporaryGrantSchema.safeParse({
      grantId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-string grantId", () => {
    const result = RevokeTemporaryGrantSchema.safeParse({ grantId: 42 });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const result = RevokeTemporaryGrantSchema.safeParse({
      grantId: VALID_UUID,
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  test("rejects non-object input", () => {
    const result = RevokeTemporaryGrantSchema.safeParse(VALID_UUID);
    expect(result.success).toBe(false);
  });
});

describe("GetGrantInputSchema (#228)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts a UUID id", () => {
    const result = GetGrantInputSchema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const result = GetGrantInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID id", () => {
    const result = GetGrantInputSchema.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const result = GetGrantInputSchema.safeParse({
      id: VALID_UUID,
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("UpdateGrantReasonInputSchema (#244)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts id + non-null reason", () => {
    const result = UpdateGrantReasonInputSchema.safeParse({
      id: VALID_UUID,
      reason: "incident response — escalation #4271",
    });
    expect(result.success).toBe(true);
  });

  test("accepts id + null reason (clearing)", () => {
    const result = UpdateGrantReasonInputSchema.safeParse({
      id: VALID_UUID,
      reason: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const result = UpdateGrantReasonInputSchema.safeParse({
      reason: "something",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing reason (must be explicit even if null)", () => {
    const result = UpdateGrantReasonInputSchema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID id", () => {
    const result = UpdateGrantReasonInputSchema.safeParse({
      id: "not-a-uuid",
      reason: "x",
    });
    expect(result.success).toBe(false);
  });

  test("rejects reason exceeding 256 chars", () => {
    const result = UpdateGrantReasonInputSchema.safeParse({
      id: VALID_UUID,
      reason: "x".repeat(257),
    });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const result = UpdateGrantReasonInputSchema.safeParse({
      id: VALID_UUID,
      reason: "x",
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});
