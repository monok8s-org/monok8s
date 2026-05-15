// L1 unit tests for tenants handlers (#29). DI-friendly: handler
// takes a deps bag (db, temporal, newId, canCreate) so tests stub
// every external without touching the real DB / WorkflowClient /
// SpiceDB client.

import { describe, expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";

import type { WorkflowClient } from "@temporalio/client";

import { createTenant, pingTenant } from "./tenants";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const ACTOR_USER_ID = "00000000-0000-0000-0000-0000000000bb";
const FIXED_WORKFLOW_ID = "00000000-0000-0000-0000-0000000000aa";
const CREATED_AT = new Date("2026-05-15T12:00:00Z");

function makeStubPool(insertedRow: Record<string, unknown>) {
  type QueryArgs = [string, unknown[]?];
  const calls: QueryArgs[] = [];
  const queryMock = jest.fn(async (...args: QueryArgs) => {
    calls.push(args);
    return { rows: [insertedRow] };
  }) as unknown as Pool["query"];
  const pool = { query: queryMock } as unknown as Pool;
  return { pool, calls };
}

function makeStubTemporal() {
  const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
    WorkflowClient["start"]
  >;
  return {
    startMock,
    temporal: {
      start: startMock,
      getHandle: jest.fn(),
    } as unknown as WorkflowClient,
  };
}

describe("createTenant (#29)", () => {
  const INSERTED = {
    id: TENANT_ID,
    slug: "acme",
    plan: "starter",
    created_at: CREATED_AT,
  };

  test("dispatches OnboardTenantWorkflow with the new tenantId + ownerEmail + plan", async () => {
    const { pool } = makeStubPool(INSERTED);
    const { startMock, temporal } = makeStubTemporal();

    const result = await createTenant(
      {
        db: pool,
        temporal,
        newId: () => FIXED_WORKFLOW_ID,
        canCreate: async () => true,
      },
      ACTOR_USER_ID,
      { slug: "acme", plan: "starter", ownerEmail: "alice@example.com" },
    );

    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-onboard-${FIXED_WORKFLOW_ID}`,
    );
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("OnboardTenantWorkflow");
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        Email: "alice@example.com",
        Plan: "starter",
      },
    ]);
  });

  test("INSERTs tenant row before dispatching the workflow", async () => {
    const { pool, calls } = makeStubPool(INSERTED);
    const { temporal } = makeStubTemporal();

    await createTenant(
      {
        db: pool,
        temporal,
        canCreate: async () => true,
      },
      ACTOR_USER_ID,
      { slug: "acme", ownerEmail: "alice@example.com" },
    );

    // Single INSERT call into tenants table.
    expect(calls).toHaveLength(1);
    const [sql, params] = calls[0]!;
    expect(sql).toMatch(/INSERT INTO tenants/);
    expect(params).toEqual(["acme", null]);
  });

  test("defaults plan to 'starter' when omitted in input", async () => {
    const { pool } = makeStubPool(INSERTED);
    const { startMock, temporal } = makeStubTemporal();

    await createTenant(
      {
        db: pool,
        temporal,
        canCreate: async () => true,
      },
      ACTOR_USER_ID,
      { slug: "acme", ownerEmail: "alice@example.com" },
    );

    const [, options] = startMock.mock.calls[0]!;
    expect((options as { args: { Plan: string }[] }).args[0]?.Plan).toBe(
      "starter",
    );
  });

  test("throws FORBIDDEN when system permission check fails", async () => {
    const { pool, calls } = makeStubPool(INSERTED);
    const { startMock, temporal } = makeStubTemporal();

    await expect(
      createTenant(
        {
          db: pool,
          temporal,
          canCreate: async () => false,
        },
        ACTOR_USER_ID,
        { slug: "acme", ownerEmail: "alice@example.com" },
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/system:monok8s#create_tenants/),
    });

    // No INSERT, no workflow start.
    expect(calls).toHaveLength(0);
    expect(startMock).not.toHaveBeenCalled();
  });

  test("falls back to randomUUID when newId is not injected", async () => {
    const { pool } = makeStubPool(INSERTED);
    const { temporal } = makeStubTemporal();

    const result = await createTenant(
      {
        db: pool,
        temporal,
        canCreate: async () => true,
      },
      ACTOR_USER_ID,
      { slug: "acme", ownerEmail: "alice@example.com" },
    );

    expect(result.workflowId).toMatch(
      new RegExp(
        `^tnt-${TENANT_ID}-onboard-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      ),
    );
  });
});

describe("pingTenant (#29)", () => {
  test("returns the tenant row when found", async () => {
    const ROW = {
      id: TENANT_ID,
      slug: "acme",
      plan: "starter",
      created_at: CREATED_AT,
    };
    const { pool } = makeStubPool(ROW);

    const result = await pingTenant(pool, TENANT_ID);
    expect(result).toEqual(ROW);
  });

  test("returns null when the tenant id does not exist", async () => {
    const queryMock = jest.fn(async () => ({ rows: [] })) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;

    const result = await pingTenant(pool, TENANT_ID);
    expect(result).toBeNull();
  });
});
