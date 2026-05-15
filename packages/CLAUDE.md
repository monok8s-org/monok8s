# packages/

Shared internal libraries consumed by `apps/`. These are not published externally.

## Import rules

**Services import from packages/, never from other apps/:**
```typescript
// RIGHT
import { verifyToken } from "@monok8s/auth"

// WRONG
import { verifyToken } from "../../apps/api/src/auth"
```

**`packages/auth` is the only place to import Zitadel or SpiceDB SDKs.**
All services use the wrappers from `packages/auth`.
This enforces a single integration point — auth SDK upgrades and breaking changes
are handled in one place, not scattered across services.

**`packages/observability` is the only place to call `sdk.start()`.**
Services call `initTelemetry(serviceName)` — never configure the OTel SDK inline.

**`packages/db` owns all schema migrations.**
Services never define their own migrations. If a service needs a new table or column,
the migration goes in `packages/db/migrations/`.

## Package index

| Package | Purpose |
|---|---|
| `auth` | Zitadel JWT verification + SpiceDB permission checks |
| `db` | Postgres client, Atlas migration config, shared query helpers |
| `observability` | OTel SDK init, shared trace/metric helpers |
| `trpc` | tRPC router init, shared procedure types |
| `flagd` | OpenFeature client setup, flag evaluation helpers |

## Adding a new package
1. Create `packages/<name>/src/index.ts` — export only what consumers need
2. Add `packages/<name>/BUILD.bazel` with a `ts_project` or `go_library` target
3. Add to `package.json` workspaces (TypeScript packages only)
4. Keep the public surface area small — internal helpers stay unexported
