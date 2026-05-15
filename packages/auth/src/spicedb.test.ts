// L1 unit tests for packages/auth/src/spicedb.ts (#33).
//
// Uses pure dependency injection via `_setClient_TESTING(...)` — no
// network, no `jest.mock("@authzed/authzed-node")` (which would trigger
// the same jest-runtime resetModules API mismatch documented in
// packages/db/src/pool.test.ts).
//
// Tests cover representative helpers from each category:
// - Permission checks: canOnTenant, canActOnMember (dual check), isPlatformAdmin
// - Single-relation writes: writeMemberJoined, writeSystemAdminRelation
// - Multi-relation writes: writeMemberRoleChanged (del + touch)
// - Caveat-context plumbing: canSAOnTenant with caveatContext
// - Schema-rule enforcement: writeGroupRoleAssigned rejects "owner"
//
// The 24 write helpers all follow the same touch-relation(s) +
// return-zedToken pattern; testing one of each shape captures the wire
// contract.

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { v1 } from "@authzed/authzed-node";

import {
  canActOnMember,
  canOnTenant,
  canOnWorkflow,
  canSAOnTenant,
  checkRelation,
  isPlatformAdmin,
  lookupResources,
  lookupSubjects,
  writeGroupRoleAssigned,
  writeMemberJoined,
  writeMemberRoleChanged,
  writeSystemAdminRelation,
  _setClient_TESTING,
} from "./spicedb.js";

type CheckCall = { req: v1.CheckPermissionRequest };
type WriteCall = { req: v1.WriteRelationshipsRequest };
type LookupResourcesCall = { req: v1.LookupResourcesRequest };
type LookupSubjectsCall = { req: v1.LookupSubjectsRequest };

interface StubClient {
  promises: {
    checkPermission: jest.MockedFunction<
      (req: v1.CheckPermissionRequest) => Promise<v1.CheckPermissionResponse>
    >;
    writeRelationships: jest.MockedFunction<
      (req: v1.WriteRelationshipsRequest) => Promise<v1.WriteRelationshipsResponse>
    >;
    lookupResources: jest.MockedFunction<
      (
        req: v1.LookupResourcesRequest,
      ) => Promise<v1.LookupResourcesResponse[]>
    >;
    lookupSubjects: jest.MockedFunction<
      (req: v1.LookupSubjectsRequest) => Promise<v1.LookupSubjectsResponse[]>
    >;
  };
  checkCalls: CheckCall[];
  writeCalls: WriteCall[];
  lookupResourcesCalls: LookupResourcesCall[];
  lookupSubjectsCalls: LookupSubjectsCall[];
}

function makeStubClient(opts?: {
  permitted?: boolean | ((req: v1.CheckPermissionRequest) => boolean);
  resourcesByRequest?: (
    req: v1.LookupResourcesRequest,
  ) => v1.LookupResourcesResponse[];
  subjectsByRequest?: (
    req: v1.LookupSubjectsRequest,
  ) => v1.LookupSubjectsResponse[];
}): StubClient {
  const checkCalls: CheckCall[] = [];
  const writeCalls: WriteCall[] = [];
  const lookupResourcesCalls: LookupResourcesCall[] = [];
  const lookupSubjectsCalls: LookupSubjectsCall[] = [];
  const p = opts?.permitted;
  const permitFn: (req: v1.CheckPermissionRequest) => boolean =
    typeof p === "function" ? p : () => p ?? true;
  const checkPermission = jest.fn(async (req: v1.CheckPermissionRequest) => {
    checkCalls.push({ req });
    return v1.CheckPermissionResponse.create({
      permissionship: permitFn(req)
        ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
        : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
    });
  });
  const writeRelationships = jest.fn(async (req: v1.WriteRelationshipsRequest) => {
    writeCalls.push({ req });
    return v1.WriteRelationshipsResponse.create({
      writtenAt: v1.ZedToken.create({ token: "fake-zedtoken-1" }),
    });
  });
  const lookupResources = jest.fn(async (req: v1.LookupResourcesRequest) => {
    lookupResourcesCalls.push({ req });
    return opts?.resourcesByRequest ? opts.resourcesByRequest(req) : [];
  });
  const lookupSubjects = jest.fn(async (req: v1.LookupSubjectsRequest) => {
    lookupSubjectsCalls.push({ req });
    return opts?.subjectsByRequest ? opts.subjectsByRequest(req) : [];
  });
  return {
    promises: {
      checkPermission,
      writeRelationships,
      lookupResources,
      lookupSubjects,
    },
    checkCalls,
    writeCalls,
    lookupResourcesCalls,
    lookupSubjectsCalls,
  };
}

let stub: StubClient;

beforeEach(() => {
  stub = makeStubClient();
  // Cast: the stub satisfies the surface we exercise (.promises.*)
  // but doesn't implement the full ZedClientInterface.
  _setClient_TESTING(stub as unknown as v1.ZedClientInterface);
});

afterEach(() => {
  _setClient_TESTING(null);
});

describe("permission checks", () => {
  test("canOnTenant builds correct CheckPermission request", async () => {
    const allowed = await canOnTenant("alice", "read", "acme");

    expect(allowed).toBe(true);
    expect(stub.checkCalls).toHaveLength(1);
    const { req } = stub.checkCalls[0];
    expect(req.resource?.objectType).toBe("tenant");
    expect(req.resource?.objectId).toBe("acme");
    expect(req.permission).toBe("read");
    expect(req.subject?.object?.objectType).toBe("user");
    expect(req.subject?.object?.objectId).toBe("alice");
    expect(req.consistency).toBeUndefined();
  });

  test("canOnTenant attaches atLeastAsFresh consistency from zedToken", async () => {
    await canOnTenant("alice", "read", "acme", "zedtoken-123");
    expect(stub.checkCalls[0].req.consistency?.requirement.oneofKind).toBe(
      "atLeastAsFresh",
    );
  });

  test("canSAOnTenant uses service_account subject + threads caveat context", async () => {
    await canSAOnTenant("ci_runner", "write", "acme", undefined, {
      client_ip: "10.0.0.1",
    });
    const { req } = stub.checkCalls[0];
    expect(req.subject?.object?.objectType).toBe("service_account");
    expect(req.context?.fields["client_ip"]?.kind.oneofKind).toBe("stringValue");
  });

  test("canActOnMember runs two parallel checks", async () => {
    await canActOnMember({
      actorId: "bob",
      targetId: "eve",
      tenantId: "acme",
      permission: "manage_members",
    });
    expect(stub.checkCalls).toHaveLength(2);
    const perms = stub.checkCalls.map((c) => c.req.permission).sort();
    expect(perms).toEqual(["manage_members", "read"]);
  });

  test("canActOnMember returns false if either check fails", async () => {
    // Permit actor; deny target.
    stub = makeStubClient({
      permitted: (req) =>
        req.subject?.object?.objectId === "bob", // actor=true, target=false
    });
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);

    const allowed = await canActOnMember({
      actorId: "bob",
      targetId: "eve",
      tenantId: "acme",
      permission: "manage_members",
    });
    expect(allowed).toBe(false);
  });

  test("isPlatformAdmin checks platform:monok8s#administrate", async () => {
    await isPlatformAdmin("alice");
    const { req } = stub.checkCalls[0];
    expect(req.resource?.objectType).toBe("platform");
    expect(req.resource?.objectId).toBe("monok8s");
    expect(req.permission).toBe("administrate");
  });

  test("NO_PERMISSION response yields false", async () => {
    stub = makeStubClient({ permitted: false });
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);
    const allowed = await canOnTenant("eve", "delete", "acme");
    expect(allowed).toBe(false);
  });
});

describe("relation writes", () => {
  test("writeMemberJoined touches one relation", async () => {
    const zt = await writeMemberJoined("acme", "eve", "member");
    expect(zt).toBe("fake-zedtoken-1");
    expect(stub.writeCalls).toHaveLength(1);
    const { updates } = stub.writeCalls[0].req;
    expect(updates).toHaveLength(1);
    expect(updates[0].operation).toBe(v1.RelationshipUpdate_Operation.TOUCH);
    expect(updates[0].relationship?.resource?.objectType).toBe("tenant");
    expect(updates[0].relationship?.relation).toBe("member");
    expect(updates[0].relationship?.subject?.object?.objectType).toBe("user");
    expect(updates[0].relationship?.subject?.object?.objectId).toBe("eve");
  });

  test("writeSystemAdminRelation targets system:monok8s", async () => {
    await writeSystemAdminRelation("bootstrap_admin");
    const { updates } = stub.writeCalls[0].req;
    expect(updates[0].relationship?.resource?.objectType).toBe("system");
    expect(updates[0].relationship?.resource?.objectId).toBe("monok8s");
    expect(updates[0].relationship?.relation).toBe("only_system_can_create_tenants");
  });

  test("writeMemberRoleChanged: delete old + touch new in same write", async () => {
    await writeMemberRoleChanged("acme", "dave", "admin", "owner");
    const { updates } = stub.writeCalls[0].req;
    expect(updates).toHaveLength(2);
    expect(updates[0].operation).toBe(v1.RelationshipUpdate_Operation.DELETE);
    expect(updates[0].relationship?.relation).toBe("admin");
    expect(updates[1].operation).toBe(v1.RelationshipUpdate_Operation.TOUCH);
    expect(updates[1].relationship?.relation).toBe("owner");
  });

  test("writeGroupRoleAssigned rejects 'owner' role at the API layer", async () => {
    await expect(writeGroupRoleAssigned("acme", "engineering", "owner")).rejects.toThrow(
      /cannot hold the `owner` role/,
    );
    expect(stub.writeCalls).toHaveLength(0);
  });

  test("writeGroupRoleAssigned writes with group#membership subject relation", async () => {
    await writeGroupRoleAssigned("acme", "engineering", "admin");
    const { updates } = stub.writeCalls[0].req;
    expect(updates[0].relationship?.subject?.object?.objectType).toBe("group");
    expect(updates[0].relationship?.subject?.optionalRelation).toBe("membership");
  });
});

// ── #175 / #87c: streaming-RPC helpers ──────────────────────────────────────
describe("checkRelation (#175)", () => {
  test("checks an arbitrary relation/permission against a typed subject", async () => {
    const allowed = await checkRelation(
      { type: "tenant", id: "acme" },
      "owner",
      { type: "user", id: "alice" },
    );
    expect(allowed).toBe(true);
    const { req } = stub.checkCalls[0];
    expect(req.resource?.objectType).toBe("tenant");
    expect(req.permission).toBe("owner");
    expect(req.subject?.object?.objectType).toBe("user");
    expect(req.subject?.object?.objectId).toBe("alice");
  });

  test("supports service_account subject + zedToken consistency", async () => {
    await checkRelation(
      { type: "tenant", id: "acme" },
      "billing_manager",
      { type: "service_account", id: "ci_runner" },
      "zedtok-7",
    );
    const { req } = stub.checkCalls[0];
    expect(req.subject?.object?.objectType).toBe("service_account");
    expect(req.consistency?.requirement.oneofKind).toBe("atLeastAsFresh");
  });
});

describe("lookupResources (#175)", () => {
  test("returns IDs from HAS_PERMISSION responses, filters NO_PERMISSION", async () => {
    stub = makeStubClient({
      resourcesByRequest: () => [
        v1.LookupResourcesResponse.create({
          resourceObjectId: "tenant-1",
          permissionship: v1.LookupPermissionship.HAS_PERMISSION,
        }),
        v1.LookupResourcesResponse.create({
          resourceObjectId: "tenant-2",
          permissionship: v1.LookupPermissionship.HAS_PERMISSION,
        }),
        v1.LookupResourcesResponse.create({
          resourceObjectId: "tenant-3",
          permissionship:
            v1.LookupPermissionship.CONDITIONAL_PERMISSION,
        }),
      ],
    });
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);

    const ids = await lookupResources("tenant", "read", {
      type: "user",
      id: "alice",
    });

    expect(ids).toEqual(["tenant-1", "tenant-2"]);
    const { req } = stub.lookupResourcesCalls[0];
    expect(req.resourceObjectType).toBe("tenant");
    expect(req.permission).toBe("read");
    expect(req.subject?.object?.objectType).toBe("user");
    expect(req.subject?.object?.objectId).toBe("alice");
  });

  test("threads zedToken consistency through the request", async () => {
    await lookupResources(
      "tenant",
      "read",
      { type: "user", id: "alice" },
      "zedtok-9",
    );
    expect(stub.lookupResourcesCalls[0].req.consistency?.requirement.oneofKind)
      .toBe("atLeastAsFresh");
  });
});

describe("canOnWorkflow (#177)", () => {
  test("parses tenant from `tnt-<uuid>-` prefix and delegates to canOnTenant", async () => {
    const tenantId = "11111111-2222-3333-4444-555555555555";
    const wid = `tnt-${tenantId}-onboard-abc123`;
    const allowed = await canOnWorkflow("alice", "read", wid);
    expect(allowed).toBe(true);
    expect(stub.checkCalls).toHaveLength(1);
    const { req } = stub.checkCalls[0];
    expect(req.resource?.objectType).toBe("tenant");
    expect(req.resource?.objectId).toBe(tenantId);
    expect(req.permission).toBe("read");
    expect(req.subject?.object?.objectId).toBe("alice");
  });

  test("returns false on malformed workflow ID (no tnt- prefix)", async () => {
    const allowed = await canOnWorkflow(
      "alice",
      "read",
      "marketplace-aws-customer42",
    );
    expect(allowed).toBe(false);
    // No SpiceDB call should fire if the prefix doesn't parse.
    expect(stub.checkCalls).toHaveLength(0);
  });

  test("returns false when canOnTenant denies", async () => {
    stub = makeStubClient({ permitted: false });
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);
    const tenantId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const allowed = await canOnWorkflow(
      "eve",
      "read",
      `tnt-${tenantId}-onboard-x`,
    );
    expect(allowed).toBe(false);
    expect(stub.checkCalls).toHaveLength(1);
  });
});

describe("lookupSubjects (#175)", () => {
  test("returns subject IDs from the resolved-subject envelope", async () => {
    stub = makeStubClient({
      subjectsByRequest: () => [
        v1.LookupSubjectsResponse.create({
          subjectObjectId: "alice",
          subject: v1.ResolvedSubject.create({
            subjectObjectId: "alice",
            permissionship: v1.LookupPermissionship.HAS_PERMISSION,
          }),
          permissionship: v1.LookupPermissionship.HAS_PERMISSION,
          excludedSubjectIds: [],
          excludedSubjects: [],
        }),
        v1.LookupSubjectsResponse.create({
          subjectObjectId: "bob",
          subject: v1.ResolvedSubject.create({
            subjectObjectId: "bob",
            permissionship: v1.LookupPermissionship.HAS_PERMISSION,
          }),
          permissionship: v1.LookupPermissionship.HAS_PERMISSION,
          excludedSubjectIds: [],
          excludedSubjects: [],
        }),
      ],
    });
    _setClient_TESTING(stub as unknown as v1.ZedClientInterface);

    const subjects = await lookupSubjects(
      { type: "tenant", id: "acme" },
      "admin",
      "user",
    );

    expect(subjects).toEqual(["alice", "bob"]);
    const { req } = stub.lookupSubjectsCalls[0];
    expect(req.resource?.objectType).toBe("tenant");
    expect(req.resource?.objectId).toBe("acme");
    expect(req.permission).toBe("admin");
    expect(req.subjectObjectType).toBe("user");
  });

  test("subjectType defaults to user; service_account override works", async () => {
    await lookupSubjects({ type: "tenant", id: "acme" }, "admin");
    expect(stub.lookupSubjectsCalls[0].req.subjectObjectType).toBe("user");

    await lookupSubjects(
      { type: "tenant", id: "acme" },
      "admin",
      "service_account",
    );
    expect(stub.lookupSubjectsCalls[1].req.subjectObjectType).toBe(
      "service_account",
    );
  });
});
