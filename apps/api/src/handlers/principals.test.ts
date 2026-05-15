// L1 unit tests for extracted principal-read handlers (#197 — Rule 11
// no_buried_chains). Each extracted handler is plain-call-testable:
// pass a stub Pool / stub SpiceDB client, assert on the result without
// going through the tRPC procedure builder.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { Pool } from "pg";

import {
  _setClient_TESTING,
  type SubjectRef,
} from "@monok8s/auth";
import { v1 } from "@authzed/authzed-node";

import type { WorkflowClient } from "@temporalio/client";

import {
  addGroupMember,
  assignTenantRole,
  changeTenantRole,
  createGroup,
  deleteGroup,
  expandPrincipalsForRole,
  getTenant,
  listGroupMembers,
  listGroupsInTenant,
  listRolesForPrincipal,
  reinstateUser,
  removeGroupMember,
  suspendUser,
  TENANT_ROLES,
  unassignTenantRole,
  updateGroup,
} from "./principals";

afterEach(() => {
  _setClient_TESTING(null);
});

// ── DB-only handlers ─────────────────────────────────────────────────────────

describe("listGroupsInTenant", () => {
  test("invokes pool.query with the tenant_id and returns rows", async () => {
    const queryMock = jest.fn(async () => ({ rows: [{ id: "g1", name: "engineering" }] })) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;

    const result = await listGroupsInTenant(pool, "tenant-1");
    expect(result).toEqual([{ id: "g1", name: "engineering" }]);
    // groups.list calls pool.query with the SELECT — assert it ran
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});

describe("createGroup", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const INSERTED = {
    id: "00000000-0000-0000-0000-0000000000aa",
    tenant_id: TENANT_ID,
    name: "engineering",
    parent_group_id: null,
    created_at: new Date("2026-05-14T00:00:00Z"),
  };

  function makeStubPool() {
    type QueryArgs = [string, unknown[]?];
    const calls: QueryArgs[] = [];
    const queryMock = jest.fn(async (...args: QueryArgs) => {
      calls.push(args);
      return { rows: [INSERTED] };
    }) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;
    return { pool, calls };
  }

  test("inserts with tenant_id from handler arg, returns the row", async () => {
    const { pool, calls } = makeStubPool();
    const result = await createGroup(pool, TENANT_ID, {
      name: "engineering",
    });

    expect(result).toEqual(INSERTED);
    // Single INSERT call. groups.create builds the INSERT with the
    // handler-supplied tenant_id at $1.
    expect(calls).toHaveLength(1);
    const [sql, params] = calls[0]!;
    expect(sql).toMatch(/INSERT INTO groups/);
    expect(params).toEqual([TENANT_ID, "engineering", null]);
  });

  test("ignores any tenant_id present on input — handler tenant arg wins", async () => {
    const { pool, calls } = makeStubPool();
    // The handler type doesn't permit tenant_id on input, but a caller
    // bypassing TS could attempt to smuggle one. Cast-around-the-type
    // simulates that and asserts the runtime invariant.
    await createGroup(pool, TENANT_ID, {
      name: "engineering",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ tenant_id: "EVIL-TENANT" } as any),
    });
    const [, params] = calls[0]!;
    // First param is the handler arg, never input.tenant_id.
    expect(params![0]).toBe(TENANT_ID);
    expect(params).not.toContain("EVIL-TENANT");
  });

  test("passes parentGroupId through to the INSERT when set", async () => {
    const { pool, calls } = makeStubPool();
    const parent = "00000000-0000-0000-0000-0000000000bb";
    await createGroup(pool, TENANT_ID, {
      name: "frontend",
      parentGroupId: parent,
    });
    const [, params] = calls[0]!;
    expect(params).toEqual([TENANT_ID, "frontend", parent]);
  });

  test("normalizes undefined parentGroupId to null at the DB boundary", async () => {
    const { pool, calls } = makeStubPool();
    await createGroup(pool, TENANT_ID, { name: "engineering" });
    const [, params] = calls[0]!;
    expect(params).toEqual([TENANT_ID, "engineering", null]);
  });

  test("propagates pool errors (e.g. FK violation on parentGroupId)", async () => {
    const fkError = Object.assign(new Error("foreign_key_violation"), {
      code: "23503",
    });
    const queryMock = jest.fn(async () => {
      throw fkError;
    }) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;

    await expect(
      createGroup(pool, TENANT_ID, {
        name: "frontend",
        parentGroupId: "00000000-0000-0000-0000-000000000099",
      }),
    ).rejects.toBe(fkError);
  });
});

describe("updateGroup", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const OTHER_TENANT = "00000000-0000-0000-0000-000000000099";
  const GROUP_ID = "00000000-0000-0000-0000-0000000000aa";
  interface GroupRow {
    id: string;
    tenant_id: string;
    name: string;
    parent_group_id: string | null;
    created_at: Date;
  }
  const EXISTING: GroupRow = {
    id: GROUP_ID,
    tenant_id: TENANT_ID,
    name: "engineering",
    parent_group_id: null,
    created_at: new Date("2026-05-14T00:00:00Z"),
  };

  // Two-call stub: first query is the findById, second is the UPDATE.
  function makeStubPool(
    findResult: GroupRow | null,
    updateResult?: GroupRow,
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

  test("updates name when group belongs to caller's tenant", async () => {
    const updated = { ...EXISTING, name: "platform-eng" };
    const { pool, calls } = makeStubPool(EXISTING, updated);

    const result = await updateGroup(pool, TENANT_ID, GROUP_ID, {
      name: "platform-eng",
    });

    expect(result).toEqual(updated);
    expect(calls).toHaveLength(2);
    expect(calls[0]![0]).toMatch(/SELECT \* FROM groups WHERE id = \$1/);
    expect(calls[1]![0]).toMatch(/UPDATE groups SET name = \$1 WHERE id = \$2/);
    expect(calls[1]![1]).toEqual(["platform-eng", GROUP_ID]);
  });

  test("returns null + skips UPDATE when group is missing", async () => {
    const { pool, calls } = makeStubPool(null);
    const result = await updateGroup(pool, TENANT_ID, GROUP_ID, {
      name: "x",
    });
    expect(result).toBeNull();
    // SELECT only — no UPDATE round-trip.
    expect(calls).toHaveLength(1);
  });

  test("returns null + skips UPDATE when group belongs to another tenant", async () => {
    const crossTenant = { ...EXISTING, tenant_id: OTHER_TENANT };
    const { pool, calls } = makeStubPool(crossTenant);
    const result = await updateGroup(pool, TENANT_ID, GROUP_ID, {
      name: "x",
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("includes parent_group_id only when present in input", async () => {
    const updated = { ...EXISTING, parent_group_id: GROUP_ID };
    const { pool, calls } = makeStubPool(EXISTING, updated);
    await updateGroup(pool, TENANT_ID, GROUP_ID, { parentGroupId: GROUP_ID });
    expect(calls[1]![0]).toMatch(/UPDATE groups SET parent_group_id = \$1/);
    expect(calls[1]![1]).toEqual([GROUP_ID, GROUP_ID]);
  });

  test("supports both fields in one UPDATE", async () => {
    const updated = { ...EXISTING, name: "x", parent_group_id: GROUP_ID };
    const { pool, calls } = makeStubPool(EXISTING, updated);
    await updateGroup(pool, TENANT_ID, GROUP_ID, {
      name: "x",
      parentGroupId: GROUP_ID,
    });
    expect(calls[1]![0]).toMatch(
      /UPDATE groups SET name = \$1, parent_group_id = \$2 WHERE id = \$3/,
    );
    expect(calls[1]![1]).toEqual(["x", GROUP_ID, GROUP_ID]);
  });
});

describe("deleteGroup", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const OTHER_TENANT = "00000000-0000-0000-0000-000000000099";
  const GROUP_ID = "00000000-0000-0000-0000-0000000000aa";
  interface GroupRow {
    id: string;
    tenant_id: string;
    name: string;
    parent_group_id: string | null;
    created_at: Date;
  }
  const EXISTING: GroupRow = {
    id: GROUP_ID,
    tenant_id: TENANT_ID,
    name: "engineering",
    parent_group_id: null,
    created_at: new Date("2026-05-14T00:00:00Z"),
  };

  function makeStubPool(findResult: GroupRow | null) {
    type QueryArgs = [string, unknown[]?];
    const calls: QueryArgs[] = [];
    const queryMock = jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params]);
      if (sql.startsWith("SELECT")) {
        return { rows: findResult === null ? [] : [findResult] };
      }
      // DELETE branch — return the id when we'd have deleted.
      return findResult ? { rows: [{ id: findResult.id }] } : { rows: [] };
    }) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;
    return { pool, calls };
  }

  test("deletes when group belongs to caller's tenant", async () => {
    const { pool, calls } = makeStubPool(EXISTING);
    const result = await deleteGroup(pool, TENANT_ID, GROUP_ID);
    expect(result).toEqual({ id: GROUP_ID });
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toMatch(/DELETE FROM groups WHERE id = \$1/);
    expect(calls[1]![1]).toEqual([GROUP_ID]);
  });

  test("returns null + skips DELETE when group is missing", async () => {
    const { pool, calls } = makeStubPool(null);
    const result = await deleteGroup(pool, TENANT_ID, GROUP_ID);
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("returns null + skips DELETE when group is in another tenant", async () => {
    const crossTenant = { ...EXISTING, tenant_id: OTHER_TENANT };
    const { pool, calls } = makeStubPool(crossTenant);
    const result = await deleteGroup(pool, TENANT_ID, GROUP_ID);
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("getTenant", () => {
  test("returns the single row matching the id, or null", async () => {
    const queryMock = jest.fn(async () => ({ rows: [{ id: "tenant-1", slug: "acme" }] })) as unknown as Pool["query"];
    const pool = { query: queryMock } as unknown as Pool;

    const result = await getTenant(pool, "tenant-1");
    expect(result).toEqual({ id: "tenant-1", slug: "acme" });
  });
});

// ── SpiceDB handlers ─────────────────────────────────────────────────────────

function setSpicedbClient(opts: {
  permitted: (req: v1.CheckPermissionRequest) => boolean;
}): { checkCalls: v1.CheckPermissionRequest[] } {
  const checkCalls: v1.CheckPermissionRequest[] = [];
  const stub = {
    promises: {
      checkPermission: jest.fn(async (req: v1.CheckPermissionRequest) => {
        checkCalls.push(req);
        return v1.CheckPermissionResponse.create({
          permissionship: opts.permitted(req)
            ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
            : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        });
      }),
      writeRelationships: jest.fn(),
      lookupSubjects: jest.fn(),
    },
  };
  _setClient_TESTING(stub as unknown as v1.ZedClientInterface);
  return { checkCalls };
}

describe("listRolesForPrincipal", () => {
  test("returns the roles the principal holds, in TENANT_ROLES order", async () => {
    const principal: SubjectRef = {
      type: "user",
      id: "00000000-0000-0000-0000-000000000001",
    };
    // Permit only admin + viewer
    setSpicedbClient({
      permitted: (req) =>
        req.permission === "admin" || req.permission === "viewer",
    });

    const result = await listRolesForPrincipal("tenant-1", principal);
    expect(result.roles).toEqual(["admin", "viewer"]);
  });

  test("returns empty list when no roles match", async () => {
    setSpicedbClient({ permitted: () => false });
    const result = await listRolesForPrincipal("tenant-1", {
      type: "user",
      id: "00000000-0000-0000-0000-000000000002",
    });
    expect(result.roles).toEqual([]);
  });

  test("issues exactly one CheckPermission per role", async () => {
    const { checkCalls } = setSpicedbClient({ permitted: () => false });
    await listRolesForPrincipal("tenant-1", {
      type: "user",
      id: "00000000-0000-0000-0000-000000000003",
    });
    expect(checkCalls).toHaveLength(TENANT_ROLES.length);
  });
});

// listGroupMembers (#258) — enumerates user subjects holding
// group#member. Stubs lookupSubjects to return synthetic subject
// shapes; asserts the result list + the SpiceDB request shape.
describe("listGroupMembers (#258)", () => {
  test("returns the user ids currently holding group#member", async () => {
    const stub = {
      promises: {
        checkPermission: jest.fn(),
        writeRelationships: jest.fn(),
        lookupSubjects: jest.fn(async () => [
          {
            subject: {
              subjectObjectId: "00000000-0000-0000-0000-0000000000aa",
              permissionship: v1.LookupPermissionship.HAS_PERMISSION,
            },
          },
          {
            subject: {
              subjectObjectId: "00000000-0000-0000-0000-0000000000bb",
              permissionship: v1.LookupPermissionship.HAS_PERMISSION,
            },
          },
        ]),
      },
    };
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);

    const result = await listGroupMembers(
      "00000000-0000-0000-0000-000000000088",
    );
    expect(result.users).toEqual([
      "00000000-0000-0000-0000-0000000000aa",
      "00000000-0000-0000-0000-0000000000bb",
    ]);
  });

  test("returns empty users when no members hold the relation", async () => {
    const stub = {
      promises: {
        checkPermission: jest.fn(),
        writeRelationships: jest.fn(),
        lookupSubjects: jest.fn(async () => []),
      },
    };
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);

    const result = await listGroupMembers(
      "00000000-0000-0000-0000-000000000088",
    );
    expect(result.users).toEqual([]);
  });

  test("queries the group resource with subjectObjectType=user", async () => {
    const lookupCalls: unknown[] = [];
    const stub = {
      promises: {
        checkPermission: jest.fn(),
        writeRelationships: jest.fn(),
        lookupSubjects: jest.fn(async (req: unknown) => {
          lookupCalls.push(req);
          return [];
        }),
      },
    };
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);

    await listGroupMembers("00000000-0000-0000-0000-000000000088");
    expect(lookupCalls).toHaveLength(1);
    const req = lookupCalls[0] as {
      resource: { objectType: string; objectId: string };
      permission: string;
      subjectObjectType: string;
    };
    expect(req.resource.objectType).toBe("group");
    expect(req.resource.objectId).toBe(
      "00000000-0000-0000-0000-000000000088",
    );
    expect(req.permission).toBe("member");
    expect(req.subjectObjectType).toBe("user");
  });
});

// expandPrincipalsForRole exercises lookupSubjects (streaming gRPC).
// The stub's lookupSubjects mock would need richer stream-emulating
// shape than checkPermission; current spicedb.test.ts covers it
// directly. Smoke-tested here via shape assertion.
describe("expandPrincipalsForRole (shape)", () => {
  test("returns { users, serviceAccounts } envelope", async () => {
    const stub = {
      promises: {
        checkPermission: jest.fn(),
        writeRelationships: jest.fn(),
        lookupSubjects: jest.fn(async () => []),
      },
    };
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);

    const result = await expandPrincipalsForRole("tenant-1", "admin");
    expect(result).toHaveProperty("users");
    expect(result).toHaveProperty("serviceAccounts");
  });
});

// ── role-assignment mutation handlers (#234) ─────────────────────────────────

describe("assignTenantRole", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const ASSIGNED_BY = "00000000-0000-0000-0000-0000000000bb";
  const FIXED_ID = "00000000-0000-0000-0000-0000000000aa";

  function makeDeps() {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const temporal = {
      start: startMock,
      getHandle: jest.fn(),
    } as unknown as WorkflowClient;
    return {
      deps: { temporal, newId: () => FIXED_ID },
      startMock,
    };
  }

  test("composes workflowId from tenantId + assignmentId + role-assign prefix", async () => {
    const { deps, startMock } = makeDeps();
    const result = await assignTenantRole(deps, TENANT_ID, ASSIGNED_BY, {
      principal: {
        id: "00000000-0000-0000-0000-000000000099",
        type: "user",
      },
      role: "admin",
    });
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-role-assign-${FIXED_ID}`,
    );
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TenantRoleAssignWorkflow");
    expect(options).toMatchObject({
      taskQueue: "onboarding",
      workflowId: `tnt-${TENANT_ID}-role-assign-${FIXED_ID}`,
    });
  });

  test("passes Go TenantRoleAssignInput-shaped args to the workflow", async () => {
    const { deps, startMock } = makeDeps();
    await assignTenantRole(deps, TENANT_ID, ASSIGNED_BY, {
      principal: {
        id: "00000000-0000-0000-0000-000000000099",
        type: "service_account",
      },
      role: "viewer",
    });
    const [, options] = startMock.mock.calls[0]!;
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        SubjectID: "00000000-0000-0000-0000-000000000099",
        SubjectType: "service_account",
        Role: "viewer",
        AssignedBy: ASSIGNED_BY,
      },
    ]);
  });

  test("falls back to randomUUID when newId is not injected", async () => {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const temporal = {
      start: startMock,
      getHandle: jest.fn(),
    } as unknown as WorkflowClient;
    const result = await assignTenantRole(
      { temporal },
      TENANT_ID,
      ASSIGNED_BY,
      {
        principal: {
          id: "00000000-0000-0000-0000-000000000099",
          type: "user",
        },
        role: "admin",
      },
    );
    // workflowId carries a v4 UUID after the prefix.
    expect(result.workflowId).toMatch(
      new RegExp(
        `^tnt-${TENANT_ID}-role-assign-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      ),
    );
  });

  test("propagates workflow start failures", async () => {
    const startError = new Error("Temporal: NamespaceNotFound");
    const startMock = jest.fn(async () => {
      throw startError;
    }) as unknown as jest.Mock<WorkflowClient["start"]>;
    const deps = {
      temporal: {
        start: startMock,
        getHandle: jest.fn(),
      } as unknown as WorkflowClient,
      newId: () => FIXED_ID,
    };
    await expect(
      assignTenantRole(deps, TENANT_ID, ASSIGNED_BY, {
        principal: {
          id: "00000000-0000-0000-0000-000000000099",
          type: "user",
        },
        role: "admin",
      }),
    ).rejects.toBe(startError);
  });
});

describe("changeTenantRole", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const CHANGED_BY = "00000000-0000-0000-0000-0000000000bb";
  const FIXED_ID = "00000000-0000-0000-0000-0000000000aa";

  test("composes workflowId with role-change prefix + dispatches to TenantRoleChangeWorkflow", async () => {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const deps = {
      temporal: {
        start: startMock,
        getHandle: jest.fn(),
      } as unknown as WorkflowClient,
      newId: () => FIXED_ID,
    };
    const result = await changeTenantRole(deps, TENANT_ID, CHANGED_BY, {
      principal: {
        id: "00000000-0000-0000-0000-000000000099",
        type: "user",
      },
      oldRole: "viewer",
      newRole: "admin",
    });
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-role-change-${FIXED_ID}`,
    );
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TenantRoleChangeWorkflow");
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        SubjectID: "00000000-0000-0000-0000-000000000099",
        SubjectType: "user",
        OldRole: "viewer",
        NewRole: "admin",
        ChangedBy: CHANGED_BY,
      },
    ]);
  });

  test("falls back to randomUUID when newId is not injected", async () => {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const result = await changeTenantRole(
      {
        temporal: {
          start: startMock,
          getHandle: jest.fn(),
        } as unknown as WorkflowClient,
      },
      TENANT_ID,
      CHANGED_BY,
      {
        principal: {
          id: "00000000-0000-0000-0000-000000000099",
          type: "user",
        },
        oldRole: "viewer",
        newRole: "admin",
      },
    );
    expect(result.workflowId).toMatch(
      new RegExp(
        `^tnt-${TENANT_ID}-role-change-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      ),
    );
  });
});

describe("unassignTenantRole", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const UNASSIGNED_BY = "00000000-0000-0000-0000-0000000000bb";
  const FIXED_ID = "00000000-0000-0000-0000-0000000000aa";

  test("composes workflowId with role-unassign prefix + dispatches to TenantRoleUnassignWorkflow", async () => {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const deps = {
      temporal: {
        start: startMock,
        getHandle: jest.fn(),
      } as unknown as WorkflowClient,
      newId: () => FIXED_ID,
    };
    const result = await unassignTenantRole(deps, TENANT_ID, UNASSIGNED_BY, {
      principal: {
        id: "00000000-0000-0000-0000-000000000099",
        type: "user",
      },
      role: "admin",
    });
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-role-unassign-${FIXED_ID}`,
    );
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TenantRoleUnassignWorkflow");
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        SubjectID: "00000000-0000-0000-0000-000000000099",
        SubjectType: "user",
        Role: "admin",
        UnassignedBy: UNASSIGNED_BY,
      },
    ]);
  });
});

describe("addGroupMember (#248)", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const ADDED_BY = "00000000-0000-0000-0000-0000000000bb";
  const FIXED_ID = "00000000-0000-0000-0000-0000000000aa";
  const GROUP_ID = "00000000-0000-0000-0000-000000000088";
  const USER_ID = "00000000-0000-0000-0000-000000000099";

  test("composes workflowId with group-add-member prefix + dispatches to TenantGroupMemberAddWorkflow", async () => {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const deps = {
      temporal: {
        start: startMock,
        getHandle: jest.fn(),
      } as unknown as WorkflowClient,
      newId: () => FIXED_ID,
    };
    const result = await addGroupMember(deps, TENANT_ID, ADDED_BY, {
      groupId: GROUP_ID,
      userId: USER_ID,
    });
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-group-add-member-${FIXED_ID}`,
    );
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TenantGroupMemberAddWorkflow");
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        GroupID: GROUP_ID,
        UserID: USER_ID,
        AddedBy: ADDED_BY,
      },
    ]);
  });

  test("falls back to randomUUID when newId is not injected", async () => {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const result = await addGroupMember(
      {
        temporal: {
          start: startMock,
          getHandle: jest.fn(),
        } as unknown as WorkflowClient,
      },
      TENANT_ID,
      ADDED_BY,
      { groupId: GROUP_ID, userId: USER_ID },
    );
    expect(result.workflowId).toMatch(
      new RegExp(
        `^tnt-${TENANT_ID}-group-add-member-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      ),
    );
  });
});

describe("removeGroupMember (#248)", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const REMOVED_BY = "00000000-0000-0000-0000-0000000000bb";
  const FIXED_ID = "00000000-0000-0000-0000-0000000000aa";
  const GROUP_ID = "00000000-0000-0000-0000-000000000088";
  const USER_ID = "00000000-0000-0000-0000-000000000099";

  test("composes workflowId with group-remove-member prefix + dispatches to TenantGroupMemberRemoveWorkflow", async () => {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const deps = {
      temporal: {
        start: startMock,
        getHandle: jest.fn(),
      } as unknown as WorkflowClient,
      newId: () => FIXED_ID,
    };
    const result = await removeGroupMember(deps, TENANT_ID, REMOVED_BY, {
      groupId: GROUP_ID,
      userId: USER_ID,
    });
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-group-remove-member-${FIXED_ID}`,
    );
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TenantGroupMemberRemoveWorkflow");
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        GroupID: GROUP_ID,
        UserID: USER_ID,
        RemovedBy: REMOVED_BY,
      },
    ]);
  });
});

// ── users.suspend / reinstate guards (#252 dispatch + #106 guards) ───────────
//
// Helper composes the SpiceDB stub used by both suspend + reinstate
// guard tests. Decision matrix the stub encodes:
//
//   - transfer_ownership permission ⇒ "is owner" check. The stub
//     returns HAS_PERMISSION when the subject userId is in
//     `ownerUserIds`.
//   - administrate permission on platform:monok8s ⇒ "is platform
//     admin" check. Stub returns HAS_PERMISSION when subject in
//     `platformAdminIds`.
//   - suspended relation on tenant ⇒ "is currently suspended" check.
//     Stub returns HAS_PERMISSION when subject in `suspendedUserIds`.
//   - lookupSubjects on `owner` ⇒ enumerate the owner set. Stub
//     returns `ownerUserIds` so the last-owner guard sees them.

function setUserSuspendStub(opts: {
  ownerUserIds?: string[];
  platformAdminIds?: string[];
  suspendedUserIds?: string[];
}) {
  const owners = opts.ownerUserIds ?? [];
  const platformAdmins = opts.platformAdminIds ?? [];
  const suspended = opts.suspendedUserIds ?? [];

  const checkCalls: v1.CheckPermissionRequest[] = [];
  const lookupCalls: unknown[] = [];

  const stub = {
    promises: {
      checkPermission: jest.fn(async (req: v1.CheckPermissionRequest) => {
        checkCalls.push(req);
        const subjectId = req.subject?.object?.objectId ?? "";
        const resourceType = req.resource?.objectType ?? "";
        let permitted = false;
        if (
          req.permission === "transfer_ownership" &&
          resourceType === "tenant"
        ) {
          permitted = owners.includes(subjectId);
        } else if (
          req.permission === "administrate" &&
          resourceType === "platform"
        ) {
          permitted = platformAdmins.includes(subjectId);
        } else if (req.permission === "suspended" && resourceType === "tenant") {
          permitted = suspended.includes(subjectId);
        }
        return v1.CheckPermissionResponse.create({
          permissionship: permitted
            ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
            : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        });
      }),
      writeRelationships: jest.fn(),
      lookupSubjects: jest.fn(async (req: unknown) => {
        lookupCalls.push(req);
        return owners.map((id) => ({
          subject: {
            subjectObjectId: id,
            permissionship: v1.LookupPermissionship.HAS_PERMISSION,
          },
        }));
      }),
    },
  };
  _setClient_TESTING(stub as unknown as v1.ZedClientInterface);
  return { checkCalls, lookupCalls };
}

describe("suspendUser (#252 dispatch + #106 guards)", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const SUSPENDED_BY = "00000000-0000-0000-0000-0000000000bb";
  const FIXED_ID = "00000000-0000-0000-0000-0000000000aa";
  const USER_ID = "00000000-0000-0000-0000-000000000099";
  const OWNER_A = "00000000-0000-0000-0000-000000000aa1";
  const OWNER_B = "00000000-0000-0000-0000-000000000aa2";

  function makeDeps(): { startMock: jest.Mock<WorkflowClient["start"]>; deps: { temporal: WorkflowClient; newId: () => string } } {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    return {
      startMock,
      deps: {
        temporal: {
          start: startMock,
          getHandle: jest.fn(),
        } as unknown as WorkflowClient,
        newId: () => FIXED_ID,
      },
    };
  }

  test("non-owner target: dispatches the workflow (positive control)", async () => {
    setUserSuspendStub({
      ownerUserIds: [OWNER_A, OWNER_B], // neither is the target — target is non-owner
    });
    const { startMock, deps } = makeDeps();
    const result = await suspendUser(deps, TENANT_ID, SUSPENDED_BY, {
      userId: USER_ID,
    });
    expect(result.workflowId).toBe(`tnt-${TENANT_ID}-user-suspend-${FIXED_ID}`);
    expect(startMock).toHaveBeenCalledTimes(1);
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TenantUserSuspendWorkflow");
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        UserID: USER_ID,
        SuspendedBy: SUSPENDED_BY,
      },
    ]);
  });

  test("owner target + actor is another owner: dispatches workflow", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID, SUSPENDED_BY], // target + actor are both owners
    });
    const { startMock, deps } = makeDeps();
    await suspendUser(deps, TENANT_ID, SUSPENDED_BY, { userId: USER_ID });
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  test("owner target + actor is platform admin: dispatches workflow", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID, OWNER_A], // target + one other owner
      platformAdminIds: [SUSPENDED_BY],
    });
    const { startMock, deps } = makeDeps();
    await suspendUser(deps, TENANT_ID, SUSPENDED_BY, { userId: USER_ID });
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  test("owner target + actor is non-owner non-admin: throws FORBIDDEN, no workflow", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID, OWNER_A], // target is owner; actor is not
    });
    const { startMock, deps } = makeDeps();
    await expect(
      suspendUser(deps, TENANT_ID, SUSPENDED_BY, { userId: USER_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/owner or platform admin/i),
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  test("last-owner target: throws FORBIDDEN, no workflow", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID], // ONLY owner
      platformAdminIds: [SUSPENDED_BY], // actor authorized to act on owner
    });
    const { startMock, deps } = makeDeps();
    await expect(
      suspendUser(deps, TENANT_ID, SUSPENDED_BY, { userId: USER_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/last owner/i),
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  test("all other owners suspended: throws FORBIDDEN (last-unsuspended-owner)", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID, OWNER_A], // target + another owner
      platformAdminIds: [SUSPENDED_BY], // actor authorized
      suspendedUserIds: [OWNER_A], // the other owner is already suspended
    });
    const { startMock, deps } = makeDeps();
    await expect(
      suspendUser(deps, TENANT_ID, SUSPENDED_BY, { userId: USER_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/last unsuspended owner/i),
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  test("falls back to randomUUID when newId is not injected", async () => {
    setUserSuspendStub({
      ownerUserIds: [OWNER_A, OWNER_B], // target is non-owner
    });
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    const result = await suspendUser(
      {
        temporal: {
          start: startMock,
          getHandle: jest.fn(),
        } as unknown as WorkflowClient,
      },
      TENANT_ID,
      SUSPENDED_BY,
      { userId: USER_ID },
    );
    expect(result.workflowId).toMatch(
      new RegExp(
        `^tnt-${TENANT_ID}-user-suspend-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      ),
    );
  });
});

describe("reinstateUser (#252 dispatch + #106 guards)", () => {
  const TENANT_ID = "00000000-0000-0000-0000-000000000001";
  const REINSTATED_BY = "00000000-0000-0000-0000-0000000000bb";
  const FIXED_ID = "00000000-0000-0000-0000-0000000000aa";
  const USER_ID = "00000000-0000-0000-0000-000000000099";
  const OWNER_A = "00000000-0000-0000-0000-000000000aa1";

  function makeDeps() {
    const startMock = jest.fn(async () => undefined) as unknown as jest.Mock<
      WorkflowClient["start"]
    >;
    return {
      startMock,
      deps: {
        temporal: {
          start: startMock,
          getHandle: jest.fn(),
        } as unknown as WorkflowClient,
        newId: () => FIXED_ID,
      },
    };
  }

  test("non-owner target: dispatches workflow", async () => {
    setUserSuspendStub({
      ownerUserIds: [OWNER_A], // target is non-owner
    });
    const { startMock, deps } = makeDeps();
    const result = await reinstateUser(deps, TENANT_ID, REINSTATED_BY, {
      userId: USER_ID,
    });
    expect(result.workflowId).toBe(
      `tnt-${TENANT_ID}-user-reinstate-${FIXED_ID}`,
    );
    const [workflowType, options] = startMock.mock.calls[0]!;
    expect(workflowType).toBe("TenantUserReinstateWorkflow");
    expect((options as { args: unknown[] }).args).toEqual([
      {
        TenantID: TENANT_ID,
        UserID: USER_ID,
        ReinstatedBy: REINSTATED_BY,
      },
    ]);
  });

  test("owner target + actor is platform admin: dispatches workflow", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID],
      platformAdminIds: [REINSTATED_BY],
    });
    const { startMock, deps } = makeDeps();
    await reinstateUser(deps, TENANT_ID, REINSTATED_BY, { userId: USER_ID });
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  test("owner target + actor is non-owner non-admin: throws FORBIDDEN", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID],
    });
    const { startMock, deps } = makeDeps();
    await expect(
      reinstateUser(deps, TENANT_ID, REINSTATED_BY, { userId: USER_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/owner or platform admin/i),
    });
    expect(startMock).not.toHaveBeenCalled();
  });

  test("reinstate does NOT run last-owner check (sole-owner target reinstates cleanly)", async () => {
    setUserSuspendStub({
      ownerUserIds: [USER_ID], // sole owner
      platformAdminIds: [REINSTATED_BY], // actor authorized
    });
    const { startMock, deps } = makeDeps();
    await reinstateUser(deps, TENANT_ID, REINSTATED_BY, { userId: USER_ID });
    expect(startMock).toHaveBeenCalledTimes(1);
  });
});
