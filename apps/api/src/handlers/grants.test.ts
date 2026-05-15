// L1 unit tests for apps/api/src/handlers/grants.ts (#224 / #91 local).
//
// createTemporaryGrant is plain-call-testable: pass synthetic
// dependencies (stubbed WorkflowClient, fixed clock, deterministic UUID
// factory) and assert on the call shape + returned values without
// going through the tRPC procedure builder.

import { describe, expect, jest, test } from "@jest/globals";
import type { WorkflowClient } from "@temporalio/client";

import type { Pool } from "pg";

import {
  createTemporaryGrant,
  getGrant,
  listGrants,
  revokeTemporaryGrant,
  updateGrantReason,
  type GrantsDeps,
} from "./grants";

describe("createTemporaryGrant", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const GRANTED_BY = "00000000-0000-0000-0000-0000000000bb";
  const SUBJECT_ID = "00000000-0000-0000-0000-000000000099";
  const FIXED_NOW = new Date("2026-05-14T12:00:00Z");
  const FIXED_GRANT_ID = "00000000-0000-0000-0000-0000000000aa";

  function makeDeps(): {
    deps: GrantsDeps;
    startMock: jest.Mock<WorkflowClient["start"]>;
  } {
    const startMock = jest.fn() as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const temporal = {
      start: startMock,
      getHandle: jest.fn(),
    } as unknown as WorkflowClient;
    return {
      deps: {
        temporal,
        now: () => FIXED_NOW,
        newId: () => FIXED_GRANT_ID,
      },
      startMock,
    };
  }

  test("composes workflowId from tenantId + grantId per #177 convention", async () => {
    const { deps, startMock } = makeDeps();
    const result = await createTemporaryGrant(deps, TENANT_ID, GRANTED_BY, {
      subjectId: SUBJECT_ID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
    });

    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-grant-${FIXED_GRANT_ID}`,
    );
    expect(startMock).toHaveBeenCalledTimes(1);
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TemporaryGrantWorkflow");
    expect(options).toMatchObject({
      taskQueue: "onboarding",
      workflowId: `tnt-${TENANT_ID}-grant-${FIXED_GRANT_ID}`,
    });
  });

  test("passes TemporaryGrantInput-shaped args to the workflow", async () => {
    const { deps, startMock } = makeDeps();
    await createTemporaryGrant(deps, TENANT_ID, GRANTED_BY, {
      subjectId: SUBJECT_ID,
      subjectType: "service_account",
      role: "viewer",
      durationSeconds: 7200,
    });

    const [, options] = startMock.mock.calls[0]!;
    // The args array carries a single struct matching the Go
    // workflow's TemporaryGrantInput shape.
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        SubjectID: SUBJECT_ID,
        SubjectType: "service_account",
        Role: "viewer",
        GrantID: FIXED_GRANT_ID,
        ExpiryISO: "2026-05-14T14:00:00.000Z", // 7200s after fixed now
      },
    ]);
  });

  test("computes ExpiryISO from durationSeconds + injected clock", async () => {
    const { deps } = makeDeps();
    const result = await createTemporaryGrant(deps, TENANT_ID, GRANTED_BY, {
      subjectId: SUBJECT_ID,
      subjectType: "user",
      role: "member",
      durationSeconds: 60,
    });
    // FIXED_NOW + 60s = 2026-05-14T12:01:00Z
    expect(result.expiresAt).toBe("2026-05-14T12:01:00.000Z");
  });

  test("returns the generated grantId + workflowId + expiresAt", async () => {
    const { deps } = makeDeps();
    const result = await createTemporaryGrant(deps, TENANT_ID, GRANTED_BY, {
      subjectId: SUBJECT_ID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
    });
    expect(result.grantId).toBe(FIXED_GRANT_ID);
    expect(result.expiresAt).toBe("2026-05-14T13:00:00.000Z");
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-grant-${FIXED_GRANT_ID}`,
    );
  });

  test("uses node:crypto's randomUUID when newId is not injected", async () => {
    const startMock = jest.fn() as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const temporal = {
      start: startMock,
      getHandle: jest.fn(),
    } as unknown as WorkflowClient;
    const deps: GrantsDeps = { temporal, now: () => FIXED_NOW };

    const result = await createTemporaryGrant(deps, TENANT_ID, GRANTED_BY, {
      subjectId: SUBJECT_ID,
      subjectType: "user",
      role: "admin",
      durationSeconds: 3600,
    });
    // randomUUID returns a v4 UUID — assert shape, not value.
    expect(result.grantId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("propagates workflow start failures", async () => {
    const startError = new Error("Temporal: NamespaceNotFound");
    const startMock = jest.fn(async () => {
      throw startError;
    }) as unknown as jest.Mock<WorkflowClient["start"]>;
    const temporal = {
      start: startMock,
      getHandle: jest.fn(),
    } as unknown as WorkflowClient;
    const deps: GrantsDeps = {
      temporal,
      now: () => FIXED_NOW,
      newId: () => FIXED_GRANT_ID,
    };

    await expect(
      createTemporaryGrant(deps, TENANT_ID, GRANTED_BY, {
        subjectId: SUBJECT_ID,
        subjectType: "user",
        role: "admin",
        durationSeconds: 3600,
      }),
    ).rejects.toBe(startError);
  });
});

describe("revokeTemporaryGrant", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const REVOKED_BY = "00000000-0000-0000-0000-0000000000bb";
  const GRANT_ID = "00000000-0000-0000-0000-0000000000aa";

  function makeDeps(signalImpl?: (name: string, payload?: unknown) => Promise<void>) {
    const signalMock = jest.fn(signalImpl ?? (async () => {}));
    const getHandleMock = jest.fn((_workflowId: string) => ({
      signal: signalMock,
    }));
    const temporal = {
      start: jest.fn(),
      getHandle: getHandleMock,
    } as unknown as WorkflowClient;
    return { temporal, getHandleMock, signalMock };
  }

  test("reconstructs workflowId from caller's tenantId + grantId convention", async () => {
    const { temporal, getHandleMock } = makeDeps();
    const result = await revokeTemporaryGrant(
      { temporal },
      TENANT_ID,
      REVOKED_BY,
      { grantId: GRANT_ID },
    );
    expect(result.workflowId).toBe(`tnt-${TENANT_ID}-grant-${GRANT_ID}`);
    expect(getHandleMock).toHaveBeenCalledWith(
      `tnt-${TENANT_ID}-grant-${GRANT_ID}`,
    );
  });

  test("signals the workflow with name 'revoke' and no payload", async () => {
    const { temporal, signalMock } = makeDeps();
    await revokeTemporaryGrant({ temporal }, TENANT_ID, REVOKED_BY, {
      grantId: GRANT_ID,
    });
    expect(signalMock).toHaveBeenCalledTimes(1);
    // Per workflow_grant.go contract: name='revoke', no payload.
    expect(signalMock).toHaveBeenCalledWith("revoke");
  });

  test("returns the reconstructed workflowId", async () => {
    const { temporal } = makeDeps();
    const result = await revokeTemporaryGrant(
      { temporal },
      TENANT_ID,
      REVOKED_BY,
      { grantId: GRANT_ID },
    );
    expect(result).toEqual({
      workflowId: `tnt-${TENANT_ID}-grant-${GRANT_ID}`,
    });
  });

  test("propagates signal failures (e.g. workflow not found)", async () => {
    const sigError = new Error("Temporal: WorkflowExecutionNotFound");
    const { temporal } = makeDeps(async () => {
      throw sigError;
    });
    await expect(
      revokeTemporaryGrant({ temporal }, TENANT_ID, REVOKED_BY, {
        grantId: GRANT_ID,
      }),
    ).rejects.toBe(sigError);
  });

  test("uses caller's tenantId — hostile cross-tenant grantId reconstructs to a different workflowId", async () => {
    const OTHER_TENANT = "00000000-0000-0000-0000-000000000099";
    const { temporal, getHandleMock } = makeDeps();
    // Caller is TENANT_ID, smuggling another tenant's grantId. The
    // reconstructed workflowId carries the CALLER's tenant, not the
    // grant's — Temporal returns NotFound (mocked here as a successful
    // call to assert the reconstruction logic, not the runtime).
    await revokeTemporaryGrant({ temporal }, TENANT_ID, REVOKED_BY, {
      grantId: GRANT_ID,
    });
    // The handle was fetched with the caller's tenant prefix, not OTHER_TENANT.
    expect(getHandleMock).toHaveBeenCalledWith(
      `tnt-${TENANT_ID}-grant-${GRANT_ID}`,
    );
    expect(getHandleMock).not.toHaveBeenCalledWith(
      `tnt-${OTHER_TENANT}-grant-${GRANT_ID}`,
    );
  });
});

describe("listGrants", () => {
  test("queries temporary_grants by tenant_id and returns rows", async () => {
    const TENANT_ID = "00000000-0000-0000-0000-000000000001";
    const ROW = {
      id: "00000000-0000-0000-0000-0000000000aa",
      tenant_id: TENANT_ID,
      subject_id: "00000000-0000-0000-0000-000000000099",
      subject_type: "user",
      role: "admin",
      granted_by: "00000000-0000-0000-0000-0000000000bb",
      reason: null,
      expires_at: new Date("2026-05-14T13:00:00Z"),
      status: "active",
      revoked_by: null,
      revoked_at: null,
      temporal_workflow_id: `tnt-${TENANT_ID}-grant-00000000-0000-0000-0000-0000000000aa`,
      created_at: new Date("2026-05-14T12:00:00Z"),
    };
    const queryMock = jest.fn(async () => ({ rows: [ROW] })) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;

    const result = await listGrants(pool, TENANT_ID);
    expect(result).toEqual([ROW]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("getGrant", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const OTHER_TENANT = "00000000-0000-0000-0000-000000000099";
  const GRANT_ID = "00000000-0000-0000-0000-0000000000aa";
  const ROW = {
    id: GRANT_ID,
    tenant_id: TENANT_ID,
    subject_id: "00000000-0000-0000-0000-000000000099",
    subject_type: "user" as const,
    role: "admin",
    granted_by: "00000000-0000-0000-0000-0000000000bb",
    reason: null,
    expires_at: new Date("2026-05-14T13:00:00Z"),
    status: "active" as const,
    revoked_by: null,
    revoked_at: null,
    temporal_workflow_id: null,
    created_at: new Date("2026-05-14T12:00:00Z"),
  };

  function makeStubPool(findResult: typeof ROW | null) {
    const queryMock = jest.fn(async () => ({
      rows: findResult === null ? [] : [findResult],
    })) as unknown as Pool["query"];
    return { query: queryMock } as unknown as Pool;
  }

  test("returns the row when tenant matches", async () => {
    const pool = makeStubPool(ROW);
    const result = await getGrant(pool, TENANT_ID, GRANT_ID);
    expect(result).toEqual(ROW);
  });

  test("returns null when row is missing", async () => {
    const pool = makeStubPool(null);
    const result = await getGrant(pool, TENANT_ID, GRANT_ID);
    expect(result).toBeNull();
  });

  test("returns null when row belongs to another tenant", async () => {
    const pool = makeStubPool({ ...ROW, tenant_id: OTHER_TENANT });
    const result = await getGrant(pool, TENANT_ID, GRANT_ID);
    expect(result).toBeNull();
  });
});

describe("updateGrantReason (#244)", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const OTHER_TENANT = "00000000-0000-0000-0000-000000000099";
  const GRANT_ID = "00000000-0000-0000-0000-0000000000aa";
  interface GrantRow {
    id: string;
    tenant_id: string;
    subject_id: string;
    subject_type: "user" | "service_account";
    role: string;
    granted_by: string;
    reason: string | null;
    expires_at: Date;
    status: "active" | "expired" | "revoked";
    revoked_by: string | null;
    revoked_at: Date | null;
    temporal_workflow_id: string | null;
    created_at: Date;
  }
  const EXISTING: GrantRow = {
    id: GRANT_ID,
    tenant_id: TENANT_ID,
    subject_id: "00000000-0000-0000-0000-000000000099",
    subject_type: "user",
    role: "admin",
    granted_by: "00000000-0000-0000-0000-0000000000bb",
    reason: null,
    expires_at: new Date("2026-05-14T13:00:00Z"),
    status: "active",
    revoked_by: null,
    revoked_at: null,
    temporal_workflow_id: null,
    created_at: new Date("2026-05-14T12:00:00Z"),
  };

  function makeStubPool(
    findResult: GrantRow | null,
    updateResult?: GrantRow,
  ) {
    type QueryArgs = [string, unknown[]?];
    const calls: QueryArgs[] = [];
    const queryMock = jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      if (sql.startsWith("SELECT")) {
        return { rows: findResult === null ? [] : [findResult] };
      }
      // UPDATE branch
      return { rows: updateResult ? [updateResult] : [] };
    }) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;
    return { pool, calls };
  }

  test("updates reason when grant belongs to caller's tenant", async () => {
    const updated = { ...EXISTING, reason: "incident response" };
    const { pool, calls } = makeStubPool(EXISTING, updated);
    const result = await updateGrantReason(
      pool,
      TENANT_ID,
      GRANT_ID,
      "incident response",
    );
    expect(result).toEqual(updated);
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatch(/SELECT \* FROM temporary_grants WHERE id = \$1/);
    expect(calls[1]![0]).toMatch(/UPDATE temporary_grants SET reason = \$1 WHERE id = \$2/);
    expect(calls[1]![1]).toEqual(["incident response", GRANT_ID]);
  });

  test("clears reason to null when null passed", async () => {
    const updated = { ...EXISTING, reason: null };
    const { pool, calls } = makeStubPool(EXISTING, updated);
    await updateGrantReason(pool, TENANT_ID, GRANT_ID, null);
    expect(calls[1]![1]).toEqual([null, GRANT_ID]);
  });

  test("returns null + skips UPDATE when grant is missing", async () => {
    const { pool, calls } = makeStubPool(null);
    const result = await updateGrantReason(
      pool,
      TENANT_ID,
      GRANT_ID,
      "reason",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1); // SELECT only — no UPDATE round-trip
  });

  test("returns null + skips UPDATE when grant belongs to another tenant", async () => {
    const crossTenant = { ...EXISTING, tenant_id: OTHER_TENANT };
    const { pool, calls } = makeStubPool(crossTenant);
    const result = await updateGrantReason(
      pool,
      TENANT_ID,
      GRANT_ID,
      "reason",
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
