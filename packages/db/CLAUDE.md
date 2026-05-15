# packages/db/

Postgres schema, Atlas migrations, and query conventions.
All services read/write through this package — never import a Postgres driver directly.

## Migration rules

**One concern per migration file. Never combine unrelated changes.**
```
001_initial.sql              ✓ initial schema
002_add_user_roles.sql       ✓ one feature
002_add_roles_and_fix_idx.sql  ✗ two concerns
```

**Migrations are append-only. Never edit a committed migration.**
If you need to fix a mistake, write a new migration that corrects it.
Editing a committed migration breaks Atlas checksum validation and corrupts
the migration history in any environment that has already applied it.

**Always write a down migration comment.**
Atlas does not auto-generate rollbacks. Document the reversal steps:
```sql
-- Up
ALTER TABLE users ADD COLUMN display_name TEXT;

-- Down (if rollback needed):
-- ALTER TABLE users DROP COLUMN display_name;
```

**Test migrations against a real Postgres instance, not mocks.**
Use `atlas migrate apply --config packages/db/atlas.hcl --env staging` locally.
The dev database is `docker://postgres/16/dev` — Atlas spins it up automatically.

## Schema conventions

**All tables have these columns:**
```sql
id         UUID PRIMARY KEY DEFAULT gen_random_uuid()
created_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Soft deletes via `deleted_at`, not hard deletes**, for any user-facing entity:
```sql
deleted_at TIMESTAMPTZ   -- NULL means active
```

**Foreign keys always have explicit ON DELETE behaviour.** No implicit defaults:
```sql
-- RIGHT
tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE

-- WRONG — implicit NO ACTION is confusing
tenant_id UUID NOT NULL REFERENCES tenants(id)
```

**Index every foreign key column.** Postgres does not do this automatically:
```sql
CREATE INDEX users_tenant_id_idx ON users(tenant_id);
```

**Use `TEXT` not `VARCHAR(n)`.** Length constraints belong in application validation,
not the schema — altering a `VARCHAR` length locks the table.

**Enum values use Postgres `TEXT` + `CHECK` constraint**, not Postgres `ENUM` type.
Postgres `ENUM` requires a schema migration to add values; CHECK constraints do not:
```sql
-- RIGHT
plan TEXT NOT NULL CHECK (plan IN ('starter', 'pro', 'enterprise'))

-- WRONG — adding 'enterprise' later requires ALTER TYPE (DDL lock)
plan plan_type NOT NULL
```

## Multi-tenancy

Every tenant-scoped table has a `tenant_id` column with a non-nullable FK to `tenants`.
Row-level security (RLS) is enabled on all tenant-scoped tables:
```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

Application code sets `app.tenant_id` at the start of each request via PgBouncer
transaction-mode pooling. Never query tenant-scoped tables without this being set.

## Event-sourced + bitemporal principal schema

Every principal type (user, service account, API key) uses this two-table pattern:

```
<principal>_events     append-only event store — source of truth
<principal>_snapshots  current-state projection — read path
```

### Two time axes

| Axis | Columns | Question answered |
|---|---|---|
| Valid time | `valid_from`, `valid_to` | When was this fact true in the real world? |
| Transaction time | `transaction_from`, `transaction_to` | When did our system record this fact? |

### Immutability rule
Event rows are immutable with one exception: `transaction_to` may be set to `now()`
to supersede an incorrect event. **`event_type` and `event_data` are never changed.**

### Correction pattern (retroactive fix)
```sql
-- 1. Close the incorrect event
UPDATE user_events SET transaction_to = now()
WHERE user_id = $id AND event_version = $v AND transaction_to IS NULL;

-- 2. Insert corrected event with original valid_from
INSERT INTO user_events (..., valid_from, transaction_from)
VALUES (..., $original_valid_from, DEFAULT);  -- transaction_from = now()
```

### Query patterns (see packages/db/queries/user_bitemporal.sql)
1. **Current state** → query `user_snapshots` (O(1))
2. **Valid time** → events WHERE `transaction_to IS NULL` AND valid range contains point
3. **Transaction time** → events WHERE transaction range contains point
4. **Full bitemporal** → events WHERE both ranges contain their respective points
5. **Full history** → all events including superseded — nothing is ever deleted

### Snapshot rebuild
Snapshots are derived by replaying current-knowledge events (`transaction_to IS NULL`).
Rebuild after every event append. Query `user_snapshots` for reads — never replay
events in the hot path.

## PII and encryption

`user_pii` stores Vault Transit ciphertext only — never plaintext.

```
Key path:  transit/keys/user-<user_id>
Format:    vault:v<version>:<base64>
```

**Always call Vault to encrypt before INSERT, decrypt after SELECT.**
Never pass plaintext to Postgres or attempt SQL-layer decryption.

Enable `convergent_encryption=true` and `derived=true` on the Transit key so that
encrypting the same email under the same key version always produces the same
ciphertext — this makes the `user_pii_email_tenant_idx` unique index work correctly.

**Crypto-shredding**: deleting `transit/keys/user-<user_id>` from Vault makes all
stored ciphertext permanently unreadable. This is the erasure mechanism — do not
hard-delete `user_events` rows; they contain no PII.

**Key rotation**: use `vault write transit/rewrap/user-<user_id>` to re-encrypt
under the latest key version. Track `key_version` in `user_pii` for rotation jobs.

## Invitation tokens

Store `SHA-256(raw_jwt)` in `invitations.token_hash`. Never store the raw token.

Verification:
```go
presented := r.FormValue("token")
hash := fmt.Sprintf("%x", sha256.Sum256([]byte(presented)))
// SELECT * FROM invitations WHERE token_hash = $1 AND status = 'pending'
```

## Query conventions

Use parameterised queries exclusively — no string interpolation into SQL.
Query helpers live in `packages/db/src/` and are the only sanctioned way to
execute queries from application code. Services do not write raw SQL.
