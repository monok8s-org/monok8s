// L1 unit tests for the extracted audit handlers (#197 / #208 —
// Rule 11 no_buried_chains). Two surfaces:
//   - pingAudit — pure function, no IO.
//   - listAuditEvents — passes filters through to packages/db's
//     audit.list. Stub Pool captures the SQL + bound parameters; the
//     handler is exercised end-to-end without a real Postgres.

import { describe, expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";

import { listAuditEvents, pingAudit, type AuditLog } from "./audit";

describe("pingAudit", () => {
  test("returns the pong envelope with tenantId + note + timestamp", () => {
    const result = pingAudit("tenant-1", "hello");
    expect(result.pong).toBe(true);
    expect(result.tenantId).toBe("tenant-1");
    expect(result.note).toBe("hello");
    expect(result.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("note=undefined becomes note=null in the envelope", () => {
    const result = pingAudit("tenant-1", undefined);
    expect(result.note).toBeNull();
  });

  test("threads tenantId verbatim", () => {
    const result = pingAudit(
      "00000000-0000-0000-0000-000000000099",
      undefined,
    );
    expect(result.tenantId).toBe("00000000-0000-0000-0000-000000000099");
  });
});

// ── listAuditEvents ─────────────────────────────────────────────────────────
//
// The handler is a pass-through to packages/db's audit.list. The L1
// surface asserts:
//   1. The right SQL shape gets sent (single SELECT with the four
//      filter clauses + ORDER BY + LIMIT).
//   2. Bound parameters match the filter object — null where omitted,
//      verbatim where present, default limit when caller doesn't set.
//   3. Returned rows surface unchanged.

interface CapturedQuery {
  text: string;
  values: unknown[];
}

function stubPool(rows: AuditLog[] = []): {
  pool: Pool;
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  const queryMock = jest.fn(
    async (text: string, values: unknown[]) => {
      captured.push({ text, values });
      return { rows };
    },
  ) as unknown as Pool["query"];
  const pool = { query: queryMock } as unknown as Pool;
  return { pool, captured };
}

const SAMPLE_ROW: AuditLog = {
  id: "00000000-0000-0000-0000-000000000aaa",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  principal_id: "00000000-0000-0000-0000-000000000002",
  principal_type: "user",
  action: "tenant.create",
  target_kind: "tenant",
  target_id: "00000000-0000-0000-0000-000000000003",
  outcome: "success",
  error_message: null,
  metadata: null,
  created_at: new Date("2026-05-13T20:00:00Z"),
};

describe("listAuditEvents", () => {
  test("no filters → bound params all null, limit 50", async () => {
    const { pool, captured } = stubPool([SAMPLE_ROW]);
    const rows = await listAuditEvents(pool, {});
    expect(rows).toEqual([SAMPLE_ROW]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.text).toContain("FROM audit_log");
    expect(captured[0]!.text).toContain("ORDER BY created_at DESC");
    expect(captured[0]!.values).toEqual([null, null, null, 50]);
  });

  test("action filter binds at $1, other params stay null", async () => {
    const { pool, captured } = stubPool();
    await listAuditEvents(pool, { action: "tenant.create" });
    expect(captured[0]!.values).toEqual([
      "tenant.create",
      null,
      null,
      50,
    ]);
  });

  test("principalId filter binds at $2", async () => {
    const { pool, captured } = stubPool();
    await listAuditEvents(pool, {
      principalId: "00000000-0000-0000-0000-000000000abc",
    });
    expect(captured[0]!.values).toEqual([
      null,
      "00000000-0000-0000-0000-000000000abc",
      null,
      50,
    ]);
  });

  test("before cursor binds at $3", async () => {
    const { pool, captured } = stubPool();
    await listAuditEvents(pool, { before: "2026-05-13T20:00:00.000Z" });
    expect(captured[0]!.values).toEqual([
      null,
      null,
      "2026-05-13T20:00:00.000Z",
      50,
    ]);
  });

  test("explicit limit overrides the default", async () => {
    const { pool, captured } = stubPool();
    await listAuditEvents(pool, { limit: 25 });
    expect(captured[0]!.values).toEqual([null, null, null, 25]);
  });

  test("all filters set — every position bound", async () => {
    const { pool, captured } = stubPool();
    await listAuditEvents(pool, {
      action: "audit.ping",
      principalId: "00000000-0000-0000-0000-000000000abc",
      before: "2026-05-13T20:00:00Z",
      limit: 10,
    });
    expect(captured[0]!.values).toEqual([
      "audit.ping",
      "00000000-0000-0000-0000-000000000abc",
      "2026-05-13T20:00:00Z",
      10,
    ]);
  });

  test("empty result returns empty array", async () => {
    const { pool } = stubPool([]);
    const rows = await listAuditEvents(pool, {});
    expect(rows).toEqual([]);
  });
});
