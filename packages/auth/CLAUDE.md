# packages/auth/

Single integration point for all authentication (Zitadel) and authorisation (SpiceDB) concerns.

## Import rule
Never import `@authzed/authzed-node`, `authzed-go`, or `jose` directly from services.
Always import from `@monok8s/auth` (TypeScript) or `packages/auth/go` (Go workers).

## Schema
`schema.zed` is the source of truth for the permission model.
Apply schema changes via:
```bash
zed schema write packages/auth/schema.zed \
  --endpoint $SPICEDB_ENDPOINT \
  --token $SPICEDB_TOKEN
```

## Permission model summary

```
platform:monok8s          one singleton, super_admin relation
tenant:<id>               owner > admin > member / viewer / billing_manager
                          roles accept user | group#membership | service_account
                          suspended subtracts from all permissions
                          denied hard-blocks all permissions (bypassed only by platform admin)
group:<id>                tenant-scoped, nestable, holds tenant roles transitively
user:<id>                 self only — user-on-user ops use canActOnMember()
service_account:<id>      non-human principal, API-key auth, can hold any role except owner
```

## suspended vs denied

| | `suspended` | `denied` |
|---|---|---|
| Who sets it | Tenant admin | Security/compliance/fraud process |
| Bypassed by | Nothing | Platform admin |
| Typical reason | Member gone quiet, billing lapse | Security incident, GDPR hold, chargeback |
| Lifted by | `writeMemberReinstated` (tenant admin) | `writeUserDeniedRevoked` (requires explicit audit trail) |
| Applies to | users, service_accounts | users, service_accounts |

Never use `denied` for routine access management. Use `suspended`.

## Relation write rules

**Every relation write returns a ZedToken.** Pass it to the next permission check
in the same request/workflow to prevent the new-enemy problem:

```typescript
// RIGHT — token prevents stale read after write
const zedToken = await writeMemberJoined(tenantId, userId, "member")
const allowed  = await canOnTenant(userId, "read", tenantId, zedToken)

// WRONG — check may use stale replica before write is visible
await writeMemberJoined(tenantId, userId, "member")
const allowed = await canOnTenant(userId, "read", tenantId)
```

**Relation writes belong in Temporal activities, not API handlers.**
An API handler that writes a relation and then fails leaves SpiceDB out of sync
with the database. Temporal activities are retried and compensated automatically.

```typescript
// RIGHT — in a Temporal activity
export async function WritePermissionsActivity(input: TenantInput) {
  return writeMemberJoined(input.tenantId, input.userId, input.role)
}

// WRONG — in an API mutation handler
export const inviteMember = tenantProcedure("manage_members").mutation(async ({ input }) => {
  await db.insertMembership(...)
  await writeMemberJoined(...)   // if this throws, DB and SpiceDB diverge
})
```

## Consistency levels

| Level | When to use |
|---|---|
| `minimizeLatency` | UI reads, listing data — slight staleness acceptable |
| `atLeastAsFresh(token)` | Any check after a write in the same request or workflow |
| `fullyConsistent` | Platform admin checks, security-critical decisions |

## Groups

Groups are tenant-scoped. Roles on `tenant` accept `group#membership` as subjects.
Groups can be nested (`group:G#member@group:H#membership`).
`owner` is the one role that cannot be assigned to a group — only individuals can own a tenant.

When a group is assigned a tenant role, all current and future group members
inherit that role automatically — no per-user relation writes needed.

Suspension applies to individual users only. To block a group's access,
revoke the group's role on the tenant (`writeGroupRoleRevoked`).

## User-on-user operations (suspend, read profile)

The previous `managing_tenant` back-reference was removed because it broke with
group-derived membership. Use `canActOnMember()` instead:

```typescript
// suspend user Y (checks actor has manage_members AND target is in same tenant)
const allowed = await canActOnMember({
  actorId:    actingUserId,
  targetId:   targetUserId,
  tenantId:   tenantId,
  permission: "manage_members",
})
```

This issues two parallel SpiceDB checks and handles group membership transparently.

## managing_tenant back-reference (removed)

This relation was removed when group membership was added. It required
maintaining a back-reference for every user in every group that held a tenant
role — a write amplification problem on every group membership change.
Replaced by `canActOnMember()` which issues two parallel tenant-level checks.

## Application-layer owner guards

The schema prevents a suspended owner from deleting or transferring, but two cases
require guards at the API layer — SpiceDB cannot enforce them alone:

**Admins cannot suspend owners.**
Before allowing a `manage_members` actor to suspend a target, check whether the
target holds the `owner` role on the tenant. Only another owner (or a platform admin)
may suspend an owner.

```typescript
// In the suspend mutation — before calling writeMemberSuspended
const targetIsOwner = await canOnTenant(input.targetUserId, "transfer_ownership", tenantId)
if (targetIsOwner) {
  const actorIsOwner   = await canOnTenant(ctx.user.userId, "transfer_ownership", tenantId)
  const actorIsPlatformAdmin = await isPlatformAdmin(ctx.user.userId)
  if (!actorIsOwner && !actorIsPlatformAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can suspend another owner" })
  }
}
```

**Last-owner protection.**
Before suspending or removing a user, verify that at least one other unsuspended
owner exists. This prevents a tenant from becoming ownerless.

This check is done at the application layer (e.g. a DB query on the SpiceDB
relationship table or a LookupSubjects call) because SpiceDB has no cardinality
constraints.

## Service accounts

Service accounts authenticate via API key, not Zitadel JWT. The auth middleware
must handle both token types and resolve to the same `{ userId, tenantId }` shape:

```typescript
// In auth middleware — check for "Bearer sk_live_..." vs "Bearer <jwt>"
const token = ctx.token ?? ""
const user = token.startsWith("sk_")
  ? await verifyApiKey(token)   // hash lookup in api_keys, returns { saId, tenantId }
  : await verifyToken(token)    // Zitadel JWT verification
```

Use `canSAOnTenant()` instead of `canOnTenant()` when the subject is a service account.
The `tenantProcedure` middleware should dispatch to the correct check based on principal type.

Service accounts can hold any role except `owner`. Assign via `writeServiceAccountCreated()`
which atomically writes the SA self-reference, tenant back-reference, and role in one batch.

## Caveats (ABAC)

Two caveats are defined in `schema.zed`:

**`expiry`** — time-bounded access. Always paired with a `TemporaryGrantWorkflow`:
```typescript
const expiryIso = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() // 4h
const zedToken = await writeTemporaryGrant({
  tenantId, subjectId: userId, subjectType: "user",
  role: "admin", expiryIso,
})
// At check time — pass now so SpiceDB can evaluate the caveat
const allowed = await canOnTenant(userId, "write", tenantId, zedToken, {
  now: new Date().toISOString(),
})
```

**`ip_allowlist`** — restrict a key to known IPs (CI runners, office ranges):
```typescript
// Written when creating the API key with an allowlist
// At check time — middleware passes the request IP
const allowed = await canSAOnTenant(saId, "write", tenantId, undefined, {
  client_ip: ctx.clientIp,
})
```

If `caveatContext` is omitted on a check against a caveat'd relation,
SpiceDB returns `PERMISSIONSHIP_NO_PERMISSION` (safe default — never grants access).

## Temporary grants (JIT elevation)

Full flow:
1. API handler validates the grant request (actor has `manage_members`, target role ≠ owner)
2. Temporal `TemporaryGrantWorkflow` is started (task queue: `"onboarding"`)
3. Activity writes SpiceDB relation with `expiry` caveat
4. Activity inserts `temporary_grants` row with `temporal_workflow_id`
5. Workflow waits until expiry or a `"revoke"` signal
6. On expiry/revoke: `deleteTemporaryGrant()` + update `temporary_grants.status`

To revoke early:
```typescript
await temporalClient.getHandle(temporalWorkflowId).signal("revoke")
```

## Adding a new permission
1. Add the relation or permission to `schema.zed`
2. Apply the schema change (zed schema write)
3. Add a typed helper to `src/spicedb.ts` and `go/spicedb.go`
4. Export from `src/index.ts`
5. Never add raw SpiceDB calls outside this package
