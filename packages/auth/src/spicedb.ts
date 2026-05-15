// SpiceDB helper surface — production impl (#33).
//
// Every monok8s service consumes SpiceDB via this module — no direct
// `@authzed/authzed-node` imports outside this package
// (see `packages/auth/CLAUDE.md`). Wraps the 0.x SDK's `.promises`
// surface so all helpers return Promises.
//
// Client is lazy-initialized from SPICEDB_ENDPOINT + SPICEDB_TOKEN env
// vars on first call. Tests inject the endpoint via the L3 itest
// harness (rules_itest exports SPICEDB_ENDPOINT from spicedb_server)
// and a known token via the L2 spicedb_test setup.

import { v1 } from "@authzed/authzed-node";
// google.protobuf.Struct is used by SpiceDB's caveat context wire format.
// The library re-exports it deep — accessible via the protobuf path below.
import { Struct } from "@authzed/authzed-node/dist/src/authzedapi/google/protobuf/struct.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TenantRole =
  | "owner"
  | "admin"
  | "member"
  | "viewer"
  | "billing_manager";

export type ServiceAccountRole = Exclude<TenantRole, "owner">;

export type TenantPermission =
  | "read"
  | "write"
  | "manage_members"
  | "manage_billing"
  | "manage_settings"
  | "delete"
  | "transfer_ownership";

export type UserPermission =
  | "update_profile"
  | "request_erasure"
  | "delete";

export type InstallationPermission = "report" | "view" | "revoke";

// WorkflowPermission — permissions on a workflow resource (#177 / #88b).
// The MVP shipped today exposes only "read" (subscribe to workflow status
// events). When tenants build their own workflows the type widens to
// include "execute" / "cancel" / "view-history" etc.
export type WorkflowPermission = "read";

export type CaveatContext = {
  now?: string;
  client_ip?: string;
};

// Subject reference for the streaming-RPC helpers (#175 / #87c).
// `user` and `service_account` are the principal types schema.zed
// recognises on every tenant role / permission.
export type SubjectRef = {
  type: "user" | "service_account";
  id: string;
};

export type LookupResourceType = "tenant" | "group" | "installation";

// ── Client setup ──────────────────────────────────────────────────────────────

let client: v1.ZedClientInterface | null = null;

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`packages/auth: env ${name} is not set`);
  return v;
}

function getClient(): v1.ZedClientInterface {
  if (!client) {
    const endpoint = mustEnv("SPICEDB_ENDPOINT");
    const token = mustEnv("SPICEDB_TOKEN");
    client = v1.NewClient(token, endpoint, v1.ClientSecurity.INSECURE_PLAINTEXT_CREDENTIALS);
  }
  return client;
}

// Test-only seam: lets unit tests inject a stub before any production
// path resolves the env-based client. Avoids the test having to set
// SPICEDB_ENDPOINT + SPICEDB_TOKEN.
export function _setClient_TESTING(c: v1.ZedClientInterface | null): void {
  client = c;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

type ObjRef = { objectType: string; objectId: string };

function obj(objectType: string, objectId: string): v1.ObjectReference {
  return v1.ObjectReference.create({ objectType, objectId });
}

function subj(
  objectType: string,
  objectId: string,
  optionalRelation?: string,
): v1.SubjectReference {
  return v1.SubjectReference.create({
    object: obj(objectType, objectId),
    optionalRelation: optionalRelation ?? "",
  });
}

function atLeastAsFresh(zedToken: string): v1.Consistency {
  return v1.Consistency.create({
    requirement: { oneofKind: "atLeastAsFresh", atLeastAsFresh: { token: zedToken } },
  });
}

function relUpdate(
  op: v1.RelationshipUpdate_Operation,
  resource: ObjRef,
  relation: string,
  subject: ObjRef,
  subjectRelation?: string,
  caveat?: { caveatName: string; context?: Record<string, unknown> },
): v1.RelationshipUpdate {
  return v1.RelationshipUpdate.create({
    operation: op,
    relationship: v1.Relationship.create({
      resource: obj(resource.objectType, resource.objectId),
      relation,
      subject: subj(subject.objectType, subject.objectId, subjectRelation),
      optionalCaveat: caveat
        ? v1.ContextualizedCaveat.create({
            caveatName: caveat.caveatName,
            context: caveat.context
              ? Struct.fromJsonString(JSON.stringify(caveat.context))
              : undefined,
          })
        : undefined,
    }),
  });
}

const touch = (
  resource: ObjRef,
  relation: string,
  subject: ObjRef,
  subjectRelation?: string,
  caveat?: { caveatName: string; context?: Record<string, unknown> },
): v1.RelationshipUpdate =>
  relUpdate(
    v1.RelationshipUpdate_Operation.TOUCH,
    resource,
    relation,
    subject,
    subjectRelation,
    caveat,
  );

const del = (
  resource: ObjRef,
  relation: string,
  subject: ObjRef,
  subjectRelation?: string,
): v1.RelationshipUpdate =>
  relUpdate(
    v1.RelationshipUpdate_Operation.DELETE,
    resource,
    relation,
    subject,
    subjectRelation,
  );

async function check(
  resource: ObjRef,
  permission: string,
  subject: ObjRef,
  subjectRelation: string | undefined,
  zedToken: string | undefined,
  caveatContext: CaveatContext | undefined,
): Promise<boolean> {
  const req = v1.CheckPermissionRequest.create({
    resource: obj(resource.objectType, resource.objectId),
    permission,
    subject: subj(subject.objectType, subject.objectId, subjectRelation),
    consistency: zedToken ? atLeastAsFresh(zedToken) : undefined,
    context:
      caveatContext && Object.keys(caveatContext).length > 0
        ? Struct.fromJsonString(JSON.stringify(caveatContext))
        : undefined,
  });
  const res = await getClient().promises.checkPermission(req);
  return (
    res.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
  );
}

async function writeRelationships(
  updates: v1.RelationshipUpdate[],
): Promise<string> {
  const res = await getClient().promises.writeRelationships(
    v1.WriteRelationshipsRequest.create({ updates }),
  );
  return res.writtenAt?.token ?? "";
}

// ── Permission checks ─────────────────────────────────────────────────────────

export async function canOnTenant(
  userId: string,
  permission: TenantPermission,
  tenantId: string,
  zedToken?: string,
  caveatContext?: CaveatContext,
): Promise<boolean> {
  return check(
    { objectType: "tenant", objectId: tenantId },
    permission,
    { objectType: "user", objectId: userId },
    undefined,
    zedToken,
    caveatContext,
  );
}

export async function canSAOnTenant(
  saId: string,
  permission: TenantPermission,
  tenantId: string,
  zedToken?: string,
  caveatContext?: CaveatContext,
): Promise<boolean> {
  return check(
    { objectType: "tenant", objectId: tenantId },
    permission,
    { objectType: "service_account", objectId: saId },
    undefined,
    zedToken,
    caveatContext,
  );
}

export async function canOnUser(
  actorId: string,
  permission: UserPermission,
  targetUserId: string,
  zedToken?: string,
): Promise<boolean> {
  return check(
    { objectType: "user", objectId: targetUserId },
    permission,
    { objectType: "user", objectId: actorId },
    undefined,
    zedToken,
    undefined,
  );
}

// canActOnMember issues TWO parallel checks: (1) actor has the named
// permission on the tenant, (2) target also has *any role* on the same
// tenant (so we don't act on a user from a different tenant). Per
// packages/auth/CLAUDE.md, this replaces the old `managing_tenant`
// back-reference pattern.
export async function canActOnMember(opts: {
  actorId: string;
  targetId: string;
  tenantId: string;
  permission: TenantPermission;
  zedToken?: string;
}): Promise<boolean> {
  const [actorOk, targetOk] = await Promise.all([
    canOnTenant(opts.actorId, opts.permission, opts.tenantId, opts.zedToken),
    canOnTenant(opts.targetId, "read", opts.tenantId, opts.zedToken),
  ]);
  return actorOk && targetOk;
}

export async function isPlatformAdmin(userId: string): Promise<boolean> {
  return check(
    { objectType: "platform", objectId: "monok8s" },
    "administrate",
    { objectType: "user", objectId: userId },
    undefined,
    undefined,
    undefined,
  );
}

// canOnSystem — permission check against `system:monok8s` (the singleton
// system resource). The only system permission shipped today is
// `create_tenants` (per `packages/auth/schema.zed`'s
// `only_system_can_create_tenants` relation); the typed string union
// captures that. Closes the TS-side TODO at middleware.ts:272 ("canOnSystem
// isn't a typed helper today") and gives `tenants.create` a clean way to
// gate the create-tenant operation.
export type SystemPermission = "create_tenants";

export async function canOnSystem(
  userId: string,
  permission: SystemPermission,
  zedToken?: string,
): Promise<boolean> {
  return check(
    { objectType: "system", objectId: "monok8s" },
    permission,
    { objectType: "user", objectId: userId },
    undefined,
    zedToken,
    undefined,
  );
}

export async function canOnInstallation(
  userId: string,
  permission: InstallationPermission,
  installationId: string,
  zedToken?: string,
): Promise<boolean> {
  return check(
    { objectType: "installation", objectId: installationId },
    permission,
    { objectType: "user", objectId: userId },
    undefined,
    zedToken,
    undefined,
  );
}

// canOnWorkflow — does this user have the named permission on the
// workflow? (#177 / #88b)
//
// MVP resolution: the workflow's owning tenant is parsed out of the
// workflow ID, which by project convention is prefixed
// `tnt-<tenantUUID>-...`. The actual permission check then delegates
// to `canOnTenant("read", <parsed-tenantId>)`. Platform admins
// transit through schema.zed's `+ platform->administrate` clause and
// pass naturally for any tenant.
//
// The helper's *contract* (signature + return semantics) is stable;
// the *implementation* will swap to a real SpiceDB workflow resource
// schema (`definition workflow_type` / `definition workflow_instance`)
// when the tenant-workflows milestone ships. Callers should not
// depend on the prefix-parsing internals.
//
// Returns false on:
//   - malformed workflow ID (no `tnt-<uuid>-` prefix)
//   - the resolved tenant does not grant the user `read`
export async function canOnWorkflow(
  userId: string,
  permission: WorkflowPermission,
  workflowId: string,
  zedToken?: string,
): Promise<boolean> {
  const tenantId = parseTenantFromWorkflowId(workflowId);
  if (!tenantId) return false;
  // `permission` is statically constrained to "read" today; the
  // canOnTenant call uses that string directly. Tomorrow's wider
  // WorkflowPermission union may need a different mapping per
  // permission name.
  return canOnTenant(userId, "read", tenantId, zedToken);
}

const WORKFLOW_TENANT_PREFIX_RE =
  /^tnt-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;

function parseTenantFromWorkflowId(workflowId: string): string | null {
  const m = workflowId.match(WORKFLOW_TENANT_PREFIX_RE);
  return m ? m[1] : null;
}

// checkRelation — like canOnTenant but lets the caller pass a raw
// relation/permission name. Used by #175's roles.list_for_principal
// to probe each role relation (owner / admin / member / ...) without
// widening the TenantPermission type union. SpiceDB's API treats
// relation names and permission names as the same lookup string.
export async function checkRelation(
  resource: { type: LookupResourceType; id: string },
  permissionOrRelation: string,
  subject: SubjectRef,
  zedToken?: string,
): Promise<boolean> {
  return check(
    { objectType: resource.type, objectId: resource.id },
    permissionOrRelation,
    { objectType: subject.type, objectId: subject.id },
    undefined,
    zedToken,
    undefined,
  );
}

// ── Lookup (streaming) helpers (#175) ─────────────────────────────────────────
//
// @authzed/authzed-node 0.18's `.promises` namespace collects the
// streaming response into Promise<Response[]>; the helpers below are
// thin extract-IDs wrappers over that. For very-large result sets the
// SDK supports cursor pagination on both calls — out of scope here
// (see plan: pagination follow-up if cardinality exceeds the default).

// lookupResources — given a subject and a (resourceType, permission),
// return the IDs of resources for which the subject has the permission.
// Use for cross-tenant queries ("which tenants is user X a member of?").
export async function lookupResources(
  resourceType: LookupResourceType,
  permission: string,
  subject: SubjectRef,
  zedToken?: string,
): Promise<string[]> {
  const req = v1.LookupResourcesRequest.create({
    resourceObjectType: resourceType,
    permission,
    subject: subj(subject.type, subject.id, undefined),
    consistency: zedToken ? atLeastAsFresh(zedToken) : undefined,
  });
  const res = await getClient().promises.lookupResources(req);
  return res
    .filter((r) => r.permissionship === v1.LookupPermissionship.HAS_PERMISSION)
    .map((r) => r.resourceObjectId);
}

// lookupSubjects — given a resource and a (permission|relation), return
// the IDs of subjects that hold it. Use for membership expansions
// ("which users hold the `admin` role on tenant Y?"). Pass the role
// relation name (e.g. "owner") to enumerate role holders; pass a
// permission name (e.g. "read") to enumerate the broader recipient set.
export async function lookupSubjects(
  resource: { type: LookupResourceType; id: string },
  permission: string,
  subjectType: "user" | "service_account" = "user",
  zedToken?: string,
): Promise<string[]> {
  const req = v1.LookupSubjectsRequest.create({
    resource: obj(resource.type, resource.id),
    permission,
    subjectObjectType: subjectType,
    consistency: zedToken ? atLeastAsFresh(zedToken) : undefined,
  });
  const res = await getClient().promises.lookupSubjects(req);
  return res
    .filter(
      (r) =>
        r.subject?.permissionship === v1.LookupPermissionship.HAS_PERMISSION,
    )
    .map((r) => r.subject!.subjectObjectId);
}

// ── Relation writes — users ───────────────────────────────────────────────────

export async function writeUserRegistered(userId: string): Promise<string> {
  return writeRelationships([
    touch({ objectType: "user", objectId: userId }, "self", { objectType: "user", objectId: userId }),
    touch({ objectType: "user", objectId: userId }, "platform", { objectType: "platform", objectId: "monok8s" }),
  ]);
}

export async function writeTenantCreated(
  tenantId: string,
  ownerUserId: string,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "tenant", objectId: tenantId }, "platform", { objectType: "platform", objectId: "monok8s" }),
    touch({ objectType: "tenant", objectId: tenantId }, "owner", { objectType: "user", objectId: ownerUserId }),
  ]);
}

export async function writeMemberJoined(
  tenantId: string,
  userId: string,
  role: TenantRole,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "tenant", objectId: tenantId }, role, { objectType: "user", objectId: userId }),
  ]);
}

export async function writeMemberRoleChanged(
  tenantId: string,
  userId: string,
  oldRole: TenantRole,
  newRole: TenantRole,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "tenant", objectId: tenantId }, oldRole, { objectType: "user", objectId: userId }),
    touch({ objectType: "tenant", objectId: tenantId }, newRole, { objectType: "user", objectId: userId }),
  ]);
}

export async function writeMemberSuspended(
  tenantId: string,
  userId: string,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "tenant", objectId: tenantId }, "suspended", { objectType: "user", objectId: userId }),
  ]);
}

export async function writeMemberReinstated(
  tenantId: string,
  userId: string,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "tenant", objectId: tenantId }, "suspended", { objectType: "user", objectId: userId }),
  ]);
}

export async function writeMemberRemoved(
  tenantId: string,
  userId: string,
  role: TenantRole,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "tenant", objectId: tenantId }, role, { objectType: "user", objectId: userId }),
    del({ objectType: "tenant", objectId: tenantId }, "suspended", { objectType: "user", objectId: userId }),
  ]);
}

// ── Relation writes — deny ────────────────────────────────────────────────────

export async function writeUserDenied(
  tenantId: string,
  userId: string,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "tenant", objectId: tenantId }, "denied", { objectType: "user", objectId: userId }),
  ]);
}

export async function writeUserDeniedRevoked(
  tenantId: string,
  userId: string,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "tenant", objectId: tenantId }, "denied", { objectType: "user", objectId: userId }),
  ]);
}

// ── Relation writes — temporary grants ────────────────────────────────────────

export async function writeTemporaryGrant(opts: {
  tenantId: string;
  subjectId: string;
  subjectType: "user" | "service_account";
  role: ServiceAccountRole;
  expiryIso: string;
}): Promise<string> {
  return writeRelationships([
    touch(
      { objectType: "tenant", objectId: opts.tenantId },
      opts.role,
      { objectType: opts.subjectType, objectId: opts.subjectId },
      undefined,
      { caveatName: "expiry", context: { expiry_time: opts.expiryIso } },
    ),
  ]);
}

export async function deleteTemporaryGrant(opts: {
  tenantId: string;
  subjectId: string;
  subjectType: "user" | "service_account";
  role: ServiceAccountRole;
}): Promise<string> {
  return writeRelationships([
    del(
      { objectType: "tenant", objectId: opts.tenantId },
      opts.role,
      { objectType: opts.subjectType, objectId: opts.subjectId },
    ),
  ]);
}

// ── Relation writes — groups ──────────────────────────────────────────────────

export async function writeGroupCreated(
  groupId: string,
  tenantId: string,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "group", objectId: groupId }, "tenant", { objectType: "tenant", objectId: tenantId }),
  ]);
}

export async function writeGroupMemberAdded(
  groupId: string,
  userId: string,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "group", objectId: groupId }, "member", { objectType: "user", objectId: userId }),
  ]);
}

export async function writeGroupMemberRemoved(
  groupId: string,
  userId: string,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "group", objectId: groupId }, "member", { objectType: "user", objectId: userId }),
  ]);
}

export async function writeGroupNested(
  parentGroupId: string,
  childGroupId: string,
): Promise<string> {
  return writeRelationships([
    // The child group's `member` set includes the parent's `member` set
    // (nested groups inherit upward).
    touch(
      { objectType: "group", objectId: parentGroupId },
      "member",
      { objectType: "group", objectId: childGroupId },
      "membership",
    ),
  ]);
}

export async function writeGroupRoleAssigned(
  tenantId: string,
  groupId: string,
  role: TenantRole,
): Promise<string> {
  if (role === "owner") {
    throw new Error("writeGroupRoleAssigned: groups cannot hold the `owner` role");
  }
  return writeRelationships([
    touch(
      { objectType: "tenant", objectId: tenantId },
      role,
      { objectType: "group", objectId: groupId },
      "membership",
    ),
  ]);
}

export async function writeGroupRoleRevoked(
  tenantId: string,
  groupId: string,
  role: TenantRole,
): Promise<string> {
  return writeRelationships([
    del(
      { objectType: "tenant", objectId: tenantId },
      role,
      { objectType: "group", objectId: groupId },
      "membership",
    ),
  ]);
}

// ── Relation writes — service accounts ────────────────────────────────────────

export async function writeServiceAccountCreated(
  saId: string,
  tenantId: string,
  role: ServiceAccountRole,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "service_account", objectId: saId }, "tenant", { objectType: "tenant", objectId: tenantId }),
    touch({ objectType: "tenant", objectId: tenantId }, role, { objectType: "service_account", objectId: saId }),
  ]);
}

export async function writeServiceAccountRoleChanged(
  tenantId: string,
  saId: string,
  oldRole: ServiceAccountRole,
  newRole: ServiceAccountRole,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "tenant", objectId: tenantId }, oldRole, { objectType: "service_account", objectId: saId }),
    touch({ objectType: "tenant", objectId: tenantId }, newRole, { objectType: "service_account", objectId: saId }),
  ]);
}

export async function writeServiceAccountSuspended(
  tenantId: string,
  saId: string,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "tenant", objectId: tenantId }, "suspended", { objectType: "service_account", objectId: saId }),
  ]);
}

export async function writeServiceAccountReinstated(
  tenantId: string,
  saId: string,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "tenant", objectId: tenantId }, "suspended", { objectType: "service_account", objectId: saId }),
  ]);
}

export async function writeServiceAccountRemoved(
  tenantId: string,
  saId: string,
  role: ServiceAccountRole,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "tenant", objectId: tenantId }, role, { objectType: "service_account", objectId: saId }),
    del({ objectType: "tenant", objectId: tenantId }, "suspended", { objectType: "service_account", objectId: saId }),
  ]);
}

// ── Relation writes — installations ───────────────────────────────────────────

export async function writeInstallationRegistered(
  installationId: string,
  tenantId: string,
): Promise<string> {
  return writeRelationships([
    touch({ objectType: "installation", objectId: installationId }, "tenant", { objectType: "tenant", objectId: tenantId }),
  ]);
}

export async function writeInstallationRevoked(
  installationId: string,
  tenantId: string,
): Promise<string> {
  return writeRelationships([
    del({ objectType: "installation", objectId: installationId }, "tenant", { objectType: "tenant", objectId: tenantId }),
  ]);
}

// ── Platform ──────────────────────────────────────────────────────────────────

export async function writePlatformAdminChanged(
  userId: string,
  operation: "TOUCH" | "DELETE",
): Promise<string> {
  const op =
    operation === "TOUCH"
      ? v1.RelationshipUpdate_Operation.TOUCH
      : v1.RelationshipUpdate_Operation.DELETE;
  return writeRelationships([
    relUpdate(
      op,
      { objectType: "platform", objectId: "monok8s" },
      "super_admin",
      { objectType: "user", objectId: userId },
    ),
  ]);
}

// ── System (admin tenant) ────────────────────────────────────────────────────

// writeSystemAdminRelation grants `only_system_can_create_tenants` on
// `system:monok8s` to the named user. Seeded once by the install-time
// bootstrap Job (#98a); thereafter the relation is closed except via
// platform-admin tooling. TS counterpart of Go's WriteSystemAdminRelation
// in packages/auth/go/spicedb.go.
export async function writeSystemAdminRelation(
  userId: string,
): Promise<string> {
  return writeRelationships([
    touch(
      { objectType: "system", objectId: "monok8s" },
      "only_system_can_create_tenants",
      { objectType: "user", objectId: userId },
    ),
  ]);
}
