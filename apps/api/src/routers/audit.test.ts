// L1 unit tests for apps/api/src/routers/audit.ts (#230 zod migration
// of parsePingInput + parseAuditListInput).
//
// Schema validation + router shape. The procedure bodies themselves
// are thin wrappers over the handlers (tested separately in
// handlers/audit.test.ts) — these cases pin the wire-boundary
// invariants: which inputs the schema accepts, which it rejects,
// and the audit.list limit-clamp transform semantics.

import { describe, expect, test } from "@jest/globals";

import {
  AuditListInputSchema,
  PingInputSchema,
  auditRouter,
} from "./audit.js";

describe("auditRouter shape", () => {
  test("loads cleanly + exposes ping + list procedures", () => {
    expect(auditRouter).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const procs = (auditRouter as any)._def.procedures;
    expect(procs).toBeDefined();
    expect(procs["ping"]).toBeDefined();
    expect(procs["list"]).toBeDefined();
  });
});

describe("PingInputSchema (#230 — migrated from parsePingInput)", () => {
  test("accepts empty object (no note)", () => {
    const result = PingInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.note).toBeUndefined();
    }
  });

  test("accepts a short note", () => {
    const result = PingInputSchema.safeParse({ note: "hello" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.note).toBe("hello");
    }
  });

  test("accepts a 64-char note", () => {
    const result = PingInputSchema.safeParse({ note: "x".repeat(64) });
    expect(result.success).toBe(true);
  });

  test("rejects a 65-char note", () => {
    const result = PingInputSchema.safeParse({ note: "x".repeat(65) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["note"]);
    }
  });

  test("rejects non-string note", () => {
    const result = PingInputSchema.safeParse({ note: 42 });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled extra field via .strict()", () => {
    const result = PingInputSchema.safeParse({
      note: "hi",
      tenant_id: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("AuditListInputSchema (#230 — migrated from parseAuditListInput)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";
  const VALID_ISO = "2026-05-14T12:00:00.000Z";

  test("accepts empty object — defaults limit to 50", () => {
    const result = AuditListInputSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.action).toBeUndefined();
      expect(result.data.principalId).toBeUndefined();
      expect(result.data.before).toBeUndefined();
    }
  });

  test("accepts an action filter within length cap", () => {
    const result = AuditListInputSchema.safeParse({ action: "tenant.create" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe("tenant.create");
    }
  });

  test("rejects empty action string", () => {
    const result = AuditListInputSchema.safeParse({ action: "" });
    expect(result.success).toBe(false);
  });

  test("rejects action exceeding 128 chars", () => {
    const result = AuditListInputSchema.safeParse({ action: "x".repeat(129) });
    expect(result.success).toBe(false);
  });

  test("accepts a UUID principalId", () => {
    const result = AuditListInputSchema.safeParse({ principalId: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects non-UUID principalId", () => {
    const result = AuditListInputSchema.safeParse({
      principalId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("accepts ISO-8601 before timestamp with Z offset", () => {
    const result = AuditListInputSchema.safeParse({ before: VALID_ISO });
    expect(result.success).toBe(true);
  });

  test("accepts ISO-8601 before timestamp with +HH:MM offset", () => {
    const result = AuditListInputSchema.safeParse({
      before: "2026-05-14T12:00:00.000+02:00",
    });
    expect(result.success).toBe(true);
  });

  test("rejects malformed before timestamp", () => {
    const result = AuditListInputSchema.safeParse({ before: "tomorrow" });
    expect(result.success).toBe(false);
  });

  test("accepts an explicit limit", () => {
    const result = AuditListInputSchema.safeParse({ limit: 25 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  test("clamps oversized limit to MAX_LIMIT (200) — operator-UX preserve semantics", () => {
    const result = AuditListInputSchema.safeParse({ limit: 9999 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(200);
    }
  });

  test("rejects zero limit", () => {
    const result = AuditListInputSchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  test("rejects negative limit", () => {
    const result = AuditListInputSchema.safeParse({ limit: -1 });
    expect(result.success).toBe(false);
  });

  test("rejects fractional limit", () => {
    const result = AuditListInputSchema.safeParse({ limit: 25.5 });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled extra field via .strict()", () => {
    const result = AuditListInputSchema.safeParse({
      action: "tenant.create",
      tenant_id: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});
