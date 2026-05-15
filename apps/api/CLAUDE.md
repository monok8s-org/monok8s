# apps/api/

TypeScript tRPC API service. Entry point for all client requests.

## Request lifecycle
```
Cloudflare → Cilium Gateway API → api service → SpiceDB (authz check)
                                             → Temporal (workflows)
                                             → Postgres (direct reads)
```

## Auth pattern
Every procedure that touches tenant data must:
1. Verify the Zitadel JWT via `packages/auth` — never verify tokens inline
2. Call SpiceDB to check the specific permission for the action
3. Never trust tenant ID from the request body — derive it from the verified token

```typescript
// RIGHT
const user = await verifyToken(ctx.token)
const allowed = await can(user.id, 'read', `tenant:${user.tenantId}`)
if (!allowed) throw new TRPCError({ code: 'FORBIDDEN' })

// WRONG — never skip the SpiceDB check
const { tenantId } = decodeJwt(ctx.token)
```

## tRPC conventions
- Domain routers live in `src/routers/<domain>.ts`, registered in `src/router.ts`
- Use `publicProcedure` only for health checks and unauthenticated endpoints
- Create an `authedProcedure` middleware that runs the auth pattern above
- Input validation via zod on every procedure — no unvalidated inputs

## Starting long-running work
Kick off Temporal workflows from procedures — never do long work inline:
```typescript
// RIGHT
await temporalClient.start(OnboardTenantWorkflow, { args: [input] })

// WRONG
await provisionDatabase(input.tenantId)   // inline, no durability
```
