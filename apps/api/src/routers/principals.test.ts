// L1 unit tests for principals.ts (#87a + #87b + #87c + #215 zod
// bootstrap).
//
// The read procedures themselves are one-line wrappers over packages/db
// helpers + tenantProcedure (tested independently in
// packages/auth/src/middleware.test.ts). The behavior-bearing code in
// principals.ts is the input-validation surface — parseId / parsePrincipal
// (inline parsers; migration to zod scheduled in a #215 follow-up) and
// RoleInputSchema (zod, #215 worked example). These tests cover the
// shape + RoleInputSchema's negative cases. parseId / parsePrincipal
// negatives are deferred to their own migration PR's tests.
//
// Deeper integration (procedure end-to-end against a real ctx) is the
// L2 itest's concern (gated on mutation work — out of #87a's scope).

import { describe, expect, test } from "@jest/globals";

import {
  AssignRoleSchema,
  ChangeRoleSchema,
  CreateGroupSchema,
  DeleteGroupInputSchema,
  GroupMembershipInputSchema,
  IdInputSchema,
  PrincipalSchema,
  RoleInputSchema,
  UnassignRoleSchema,
  UpdateGroupInputSchema,
  UserSuspensionInputSchema,
  principalsRouter,
} from "./principals.js";

describe("principalsRouter shape", () => {
  test("loads cleanly + exposes the expected sub-routers", () => {
    expect(principalsRouter).toBeDefined();
    // tRPC routers carry _def.procedures with the nested keys.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const procs = (principalsRouter as any)._def.procedures;
    expect(procs).toBeDefined();
    expect(procs["tenants.list"]).toBeDefined();
    expect(procs["tenants.get"]).toBeDefined();
    expect(procs["users.list"]).toBeDefined();
    expect(procs["users.get"]).toBeDefined();
    // groups.* landed with #174 / #87b.
    expect(procs["groups.list"]).toBeDefined();
    expect(procs["groups.get"]).toBeDefined();
    // roles.* landed with #175 / #87c.
    expect(procs["roles.list_for_principal"]).toBeDefined();
    expect(procs["roles.expand_for_role"]).toBeDefined();
    // groups.create landed with #217 (first mutation; #87 mutation tail).
    expect(procs["groups.create"]).toBeDefined();
    // groups.update + groups.delete landed with #220.
    expect(procs["groups.update"]).toBeDefined();
    expect(procs["groups.delete"]).toBeDefined();
    // roles.assign + roles.unassign landed with #234.
    expect(procs["roles.assign"]).toBeDefined();
    expect(procs["roles.unassign"]).toBeDefined();
    // roles.change landed with #236.
    expect(procs["roles.change"]).toBeDefined();
    // groups.add_member + groups.remove_member landed with #248.
    expect(procs["groups.add_member"]).toBeDefined();
    expect(procs["groups.remove_member"]).toBeDefined();
    // users.suspend + users.reinstate landed with #252.
    expect(procs["users.suspend"]).toBeDefined();
    expect(procs["users.reinstate"]).toBeDefined();
    // groups.list_members landed with #258.
    expect(procs["groups.list_members"]).toBeDefined();
  });
});

describe("IdInputSchema (#230 zod migration of parseId)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts a UUID id", () => {
    const result = IdInputSchema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(true);
  });

  test("rejects missing id", () => {
    const result = IdInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID id", () => {
    const result = IdInputSchema.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  test("rejects non-string id", () => {
    const result = IdInputSchema.safeParse({ id: 42 });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled extra field via .strict()", () => {
    const result = IdInputSchema.safeParse({
      id: VALID_UUID,
      tenant_id: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("PrincipalSchema (#230 zod migration of parsePrincipal)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts user principal", () => {
    const result = PrincipalSchema.safeParse({
      id: VALID_UUID,
      type: "user",
    });
    expect(result.success).toBe(true);
  });

  test("accepts service_account principal", () => {
    const result = PrincipalSchema.safeParse({
      id: VALID_UUID,
      type: "service_account",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown subject type", () => {
    const result = PrincipalSchema.safeParse({
      id: VALID_UUID,
      type: "group",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID id", () => {
    const result = PrincipalSchema.safeParse({
      id: "not-a-uuid",
      type: "user",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing id", () => {
    const result = PrincipalSchema.safeParse({ type: "user" });
    expect(result.success).toBe(false);
  });

  test("rejects missing type", () => {
    const result = PrincipalSchema.safeParse({ id: VALID_UUID });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled extra field via .strict()", () => {
    const result = PrincipalSchema.safeParse({
      id: VALID_UUID,
      type: "user",
      tenant_id: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("RoleInputSchema (#215 zod worked example)", () => {
  test("accepts each valid TenantRole", () => {
    for (const role of [
      "owner",
      "admin",
      "member",
      "viewer",
      "billing_manager",
    ]) {
      const result = RoleInputSchema.safeParse({ role });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe(role);
      }
    }
  });

  test("rejects an unknown role string", () => {
    const result = RoleInputSchema.safeParse({ role: "superadmin" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod's enum-mismatch error code is `invalid_enum_value` (zod 3.x).
      expect(result.error.issues[0]?.code).toBe("invalid_enum_value");
      expect(result.error.issues[0]?.path).toEqual(["role"]);
    }
  });

  test("rejects a non-string role", () => {
    const result = RoleInputSchema.safeParse({ role: 42 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["role"]);
    }
  });

  test("rejects a missing role property", () => {
    const result = RoleInputSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["role"]);
    }
  });

  test("rejects non-object input", () => {
    const result = RoleInputSchema.safeParse("owner");
    expect(result.success).toBe(false);
  });
});

describe("CreateGroupSchema (#217 first mutation)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts a name + omitted parentGroupId (top-level group)", () => {
    const result = CreateGroupSchema.safeParse({ name: "engineering" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe("engineering");
      expect(result.data.parentGroupId).toBeUndefined();
    }
  });

  test("accepts a name + explicit null parentGroupId", () => {
    const result = CreateGroupSchema.safeParse({
      name: "engineering",
      parentGroupId: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentGroupId).toBeNull();
    }
  });

  test("accepts a UUID parentGroupId (nested group)", () => {
    const result = CreateGroupSchema.safeParse({
      name: "frontend",
      parentGroupId: VALID_UUID,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parentGroupId).toBe(VALID_UUID);
    }
  });

  test("rejects empty name", () => {
    const result = CreateGroupSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["name"]);
    }
  });

  test("rejects name exceeding 128 chars", () => {
    const result = CreateGroupSchema.safeParse({ name: "x".repeat(129) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["name"]);
    }
  });

  test("rejects non-string name", () => {
    const result = CreateGroupSchema.safeParse({ name: 42 });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID parentGroupId", () => {
    const result = CreateGroupSchema.safeParse({
      name: "engineering",
      parentGroupId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["parentGroupId"]);
    }
  });

  test("rejects smuggled tenant_id (.strict() bites)", () => {
    const result = CreateGroupSchema.safeParse({
      name: "engineering",
      tenant_id: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod 3.x emits unrecognized_keys when an extra field is present
      // on a .strict() object schema.
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  test("rejects any other extra field (also via .strict())", () => {
    const result = CreateGroupSchema.safeParse({
      name: "engineering",
      arbitrary: "field",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("UpdateGroupInputSchema (#220)", () => {
  const VALID_ID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts id + name only", () => {
    const result = UpdateGroupInputSchema.safeParse({
      id: VALID_ID,
      name: "platform-eng",
    });
    expect(result.success).toBe(true);
  });

  test("accepts id + parentGroupId only", () => {
    const result = UpdateGroupInputSchema.safeParse({
      id: VALID_ID,
      parentGroupId: VALID_ID,
    });
    expect(result.success).toBe(true);
  });

  test("accepts id + parentGroupId=null (move to top-level)", () => {
    const result = UpdateGroupInputSchema.safeParse({
      id: VALID_ID,
      parentGroupId: null,
    });
    expect(result.success).toBe(true);
  });

  test("accepts id + both fields together", () => {
    const result = UpdateGroupInputSchema.safeParse({
      id: VALID_ID,
      name: "x",
      parentGroupId: VALID_ID,
    });
    expect(result.success).toBe(true);
  });

  test("rejects empty update (id only — nothing to update)", () => {
    const result = UpdateGroupInputSchema.safeParse({ id: VALID_ID });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least one of/);
    }
  });

  test("rejects missing id", () => {
    const result = UpdateGroupInputSchema.safeParse({ name: "x" });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID id", () => {
    const result = UpdateGroupInputSchema.safeParse({
      id: "not-a-uuid",
      name: "x",
    });
    expect(result.success).toBe(false);
  });

  test("rejects name too long", () => {
    const result = UpdateGroupInputSchema.safeParse({
      id: VALID_ID,
      name: "x".repeat(129),
    });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled extra field via .strict()", () => {
    const result = UpdateGroupInputSchema.safeParse({
      id: VALID_ID,
      name: "x",
      tenant_id: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("DeleteGroupInputSchema (#220)", () => {
  const VALID_ID = "00000000-0000-0000-0000-0000000000aa";

  test("accepts a UUID id", () => {
    const result = DeleteGroupInputSchema.safeParse({ id: VALID_ID });
    expect(result.success).toBe(true);
  });

  test("rejects non-UUID id", () => {
    const result = DeleteGroupInputSchema.safeParse({ id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  test("rejects missing id", () => {
    const result = DeleteGroupInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenant_id via .strict()", () => {
    const result = DeleteGroupInputSchema.safeParse({
      id: VALID_ID,
      tenant_id: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("AssignRoleSchema (#234)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-000000000099";
  const VALID_INPUT = {
    principal: { id: VALID_UUID, type: "user" as const },
    role: "admin" as const,
  };

  test("accepts user assignment to each non-owner role", () => {
    for (const role of ["admin", "member", "viewer", "billing_manager"]) {
      const result = AssignRoleSchema.safeParse({
        ...VALID_INPUT,
        role,
      });
      expect(result.success).toBe(true);
    }
  });

  test("accepts user → owner assignment", () => {
    const result = AssignRoleSchema.safeParse({
      ...VALID_INPUT,
      role: "owner",
    });
    expect(result.success).toBe(true);
  });

  test("accepts service_account → admin assignment", () => {
    const result = AssignRoleSchema.safeParse({
      principal: { id: VALID_UUID, type: "service_account" },
      role: "admin",
    });
    expect(result.success).toBe(true);
  });

  test("rejects service_account → owner via .refine()", () => {
    const result = AssignRoleSchema.safeParse({
      principal: { id: VALID_UUID, type: "service_account" },
      role: "owner",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/owner/);
      expect(result.error.issues[0]?.path).toEqual(["role"]);
    }
  });

  test("rejects unknown role", () => {
    const result = AssignRoleSchema.safeParse({
      ...VALID_INPUT,
      role: "superuser",
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown principal type", () => {
    const result = AssignRoleSchema.safeParse({
      principal: { id: VALID_UUID, type: "group" },
      role: "admin",
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID principal.id", () => {
    const result = AssignRoleSchema.safeParse({
      principal: { id: "not-a-uuid", type: "user" },
      role: "admin",
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing principal", () => {
    const result = AssignRoleSchema.safeParse({ role: "admin" });
    expect(result.success).toBe(false);
  });

  test("rejects missing role", () => {
    const result = AssignRoleSchema.safeParse({
      principal: { id: VALID_UUID, type: "user" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const result = AssignRoleSchema.safeParse({
      ...VALID_INPUT,
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("UnassignRoleSchema (#234)", () => {
  // Shares the AssignRoleSchema base — single happy-path + the refine-
  // negative case suffice (full negative coverage would just duplicate).
  const VALID_UUID = "00000000-0000-0000-0000-000000000099";

  test("accepts the canonical assignment shape", () => {
    const result = UnassignRoleSchema.safeParse({
      principal: { id: VALID_UUID, type: "user" },
      role: "admin",
    });
    expect(result.success).toBe(true);
  });

  test("rejects service_account → owner (same refine as assign)", () => {
    const result = UnassignRoleSchema.safeParse({
      principal: { id: VALID_UUID, type: "service_account" },
      role: "owner",
    });
    expect(result.success).toBe(false);
  });
});

describe("ChangeRoleSchema (#236)", () => {
  const VALID_UUID = "00000000-0000-0000-0000-000000000099";
  const VALID_INPUT = {
    principal: { id: VALID_UUID, type: "user" as const },
    oldRole: "viewer" as const,
    newRole: "admin" as const,
  };

  test("accepts a valid role change", () => {
    const result = ChangeRoleSchema.safeParse(VALID_INPUT);
    expect(result.success).toBe(true);
  });

  test("rejects oldRole === newRole (no-op rejection)", () => {
    const result = ChangeRoleSchema.safeParse({
      ...VALID_INPUT,
      oldRole: "admin",
      newRole: "admin",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/differ/);
      expect(result.error.issues[0]?.path).toEqual(["newRole"]);
    }
  });

  test("rejects newRole=owner for service_account principal", () => {
    const result = ChangeRoleSchema.safeParse({
      principal: { id: VALID_UUID, type: "service_account" },
      oldRole: "admin",
      newRole: "owner",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/owner/);
      expect(result.error.issues[0]?.path).toEqual(["newRole"]);
    }
  });

  test("accepts user → owner promotion", () => {
    const result = ChangeRoleSchema.safeParse({
      ...VALID_INPUT,
      newRole: "owner",
    });
    expect(result.success).toBe(true);
  });

  test("accepts owner → admin demotion", () => {
    const result = ChangeRoleSchema.safeParse({
      ...VALID_INPUT,
      oldRole: "owner",
      newRole: "admin",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing oldRole", () => {
    const { oldRole: _, ...rest } = VALID_INPUT;
    const result = ChangeRoleSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  test("rejects unknown role string", () => {
    const result = ChangeRoleSchema.safeParse({
      ...VALID_INPUT,
      newRole: "superuser",
    });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const result = ChangeRoleSchema.safeParse({
      ...VALID_INPUT,
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("GroupMembershipInputSchema (#248)", () => {
  const VALID_GROUP = "00000000-0000-0000-0000-000000000088";
  const VALID_USER = "00000000-0000-0000-0000-000000000099";

  test("accepts a UUID groupId + UUID userId", () => {
    const result = GroupMembershipInputSchema.safeParse({
      groupId: VALID_GROUP,
      userId: VALID_USER,
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing groupId", () => {
    const result = GroupMembershipInputSchema.safeParse({ userId: VALID_USER });
    expect(result.success).toBe(false);
  });

  test("rejects missing userId", () => {
    const result = GroupMembershipInputSchema.safeParse({
      groupId: VALID_GROUP,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID groupId", () => {
    const result = GroupMembershipInputSchema.safeParse({
      groupId: "not-a-uuid",
      userId: VALID_USER,
    });
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID userId", () => {
    const result = GroupMembershipInputSchema.safeParse({
      groupId: VALID_GROUP,
      userId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const result = GroupMembershipInputSchema.safeParse({
      groupId: VALID_GROUP,
      userId: VALID_USER,
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});

describe("UserSuspensionInputSchema (#252)", () => {
  const VALID_USER = "00000000-0000-0000-0000-000000000099";

  test("accepts a UUID userId", () => {
    const result = UserSuspensionInputSchema.safeParse({ userId: VALID_USER });
    expect(result.success).toBe(true);
  });

  test("rejects missing userId", () => {
    const result = UserSuspensionInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects non-UUID userId", () => {
    const result = UserSuspensionInputSchema.safeParse({
      userId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  test("rejects smuggled tenantId via .strict()", () => {
    const result = UserSuspensionInputSchema.safeParse({
      userId: VALID_USER,
      tenantId: "EVIL-TENANT",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  test("rejects smuggled reason field via .strict()", () => {
    const result = UserSuspensionInputSchema.safeParse({
      userId: VALID_USER,
      reason: "billing lapse",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});
