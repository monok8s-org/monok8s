// packages/auth — single integration point for all auth concerns.
// Import from here. Never import @authzed/authzed-node or zitadel SDKs directly.
// See packages/auth/schema.zed for the full permission model.

// ── SpiceDB (AuthZ) ───────────────────────────────────────────────────────────
export {
  // Permission checks
  canOnInstallation,
  canOnTenant,
  canOnWorkflow,
  canSAOnTenant,
  canOnUser,
  canActOnMember,
  checkRelation,
  isPlatformAdmin,
  canOnSystem,
  type SystemPermission,
  lookupResources,
  lookupSubjects,

  // Relation writes — call these from Temporal activities, not inline in handlers
  writeUserRegistered,
  writeTenantCreated,
  writeMemberJoined,
  writeMemberRoleChanged,
  writeMemberSuspended,
  writeMemberReinstated,
  writeMemberRemoved,
  writeUserDenied,
  writeUserDeniedRevoked,
  writeTemporaryGrant,
  deleteTemporaryGrant,
  writeGroupCreated,
  writeGroupMemberAdded,
  writeGroupMemberRemoved,
  writeGroupNested,
  writeGroupRoleAssigned,
  writeGroupRoleRevoked,
  writeServiceAccountCreated,
  writeServiceAccountRoleChanged,
  writeServiceAccountSuspended,
  writeServiceAccountReinstated,
  writeServiceAccountRemoved,
  writeInstallationRegistered,
  writeInstallationRevoked,
  writePlatformAdminChanged,

  // Types
  type TenantRole,
  type ServiceAccountRole,
  type TenantPermission,
  type UserPermission,
  type InstallationPermission,
  type CaveatContext,
  type LookupResourceType,
  type SubjectRef,
  type WorkflowPermission,
} from "./spicedb.js";

// ── Zitadel (AuthN) ───────────────────────────────────────────────────────────
export { hasMFA, verifyToken, type VerifiedUser } from "./zitadel.js";

// ── tRPC middleware (#89) ─────────────────────────────────────────────────────
export {
  authedProcedure,
  tenantProcedure,
  requirePermission,
  type PermissionResource,
} from "./middleware.js";

// ── Audit middleware (#179 / #88c) ────────────────────────────────────────────
export {
  auditMiddleware,
  auditedMutation,
  setAuditEmitter,
  type AuditEnvelope,
  type AuditEventSpec,
  type AuditPrincipal,
  type AuditTarget,
  type AuditOutcome,
  type AuditCtx,
  type AuditEmitter,
} from "./middleware.js";

// ── Test seams (used by L2 itests in consuming services) ──────────────────────
// Production code never imports these. They're re-exported here so
// service-level integration tests (e.g. apps/api/test/events_l2_test.ts
// from #88a) can swap the auth dependencies for hermetic fixtures
// without reaching into packages/auth/src/* directly.
export {
  _setPoolFactory_TESTING,
  _setVerifier_TESTING,
  _setAuditEmitter_TESTING,
} from "./middleware.js";
export { _setClient_TESTING } from "./spicedb.js";
