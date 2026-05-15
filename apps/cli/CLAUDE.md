# apps/cli/

Go CLI binary (`monok8s`) for managing monok8s resources from the terminal.
Distributed as a single static binary; no runtime dependencies beyond the OS.

## Command structure

```
monok8s
├── auth
│   ├── login           — exchange cloud/API-key credentials for a cached JWT
│   └── whoami          — print authenticated identity
├── tenant
│   ├── list            — list tenants (filterable by status)
│   ├── get <id>        — tenant detail + cloud resource inventory
│   ├── onboard         — trigger OnboardTenantWorkflow
│   ├── offboard <id>   — trigger OffboardTenantWorkflow (--confirm required)
│   └── resources <id>  — live cloud resource list with optional --diff
├── role
│   ├── list            — list role assignments for a tenant
│   ├── assign          — write to SpiceDB; Crossplane projects to cloud IAM
│   ├── revoke          — remove from SpiceDB; Crossplane reconciles cloud
│   └── sync            — force immediate Crossplane reconciliation
├── drift
│   ├── check           — diff SpiceDB vs live cloud IAM (per-tenant or --all)
│   └── reconcile       — trigger sync + optionally revert orphaned assignments
├── findings
│   ├── list            — security findings from SCC/Security Hub/Defender
│   └── resolve <id>    — mark a finding resolved
├── access-review
│   ├── list            — assignments pending recertification decision
│   ├── decide          — signal the Temporal workflow with confirm/revoke
│   └── trigger         — start an out-of-cycle review for a tenant
└── installation
    ├── list
    ├── register        — create pending install + print bootstrap token
    ├── revoke <id>
    └── rotate-key <id>
```

## Authentication

The CLI uses a three-tier credential resolution in `internal/client/auth.go`:

1. `--api-key` / `MONOK8S_API_KEY` — direct API key
2. Cloud identity auto-detect — shells out to `gcloud auth print-access-token`,
   `aws sts get-caller-identity`, or `az account get-access-token` and exchanges
   the cloud token for a monok8s JWT via the `/auth/token` endpoint
3. Cached JWT in `~/.monok8s/config` (written by `monok8s auth login`)

`MONOK8S_CLOUD_TOKEN` env var skips the shell-out (used by the cloud extensions
to pass a token they already obtained).

## Cloud extensions

The CLI is the single implementation. Three thin wrappers integrate it with
each cloud's native CLI:

| Extension | Invocation | Location |
|---|---|---|
| Azure CLI extension | `az monok8s <cmd>` | `extensions/azure/` |
| AWS CLI plugin | `aws monok8s <cmd>` | `extensions/aws/` |
| gcloud wrapper | `gcloud monok8s <cmd>` | `extensions/gcloud/gcloud-monok8s` |

Each wrapper obtains the cloud session token and sets `MONOK8S_CLOUD` +
`MONOK8S_CLOUD_TOKEN` env vars before exec-ing the `monok8s` binary.

## Output formats

`-o table` (default), `-o json`, `-o yaml`. The `output.Print` helper in
`internal/output/print.go` handles all three. Table columns are defined per
command using `output.Columns()` + `output.Row()` option functions.

## API surface

All commands call the monok8s REST API at `/api/v1/` (a JSON gateway backed
by tRPC procedures). The API client is in `internal/client/api.go`.

`drift check` is the only command that makes cloud API calls directly —
it queries Crossplane composite resource status via the Kubernetes API,
which the API server proxies. No cloud credentials are needed on the CLI side
for drift check; the API server holds the cloud credentials via workload identity.

## Adding a new command

1. Add a `cmd/<domain>.go` file with the command group and subcommands
2. Register it in `cmd/root.go` `root.AddCommand(...)`
3. Add corresponding API endpoint in `apps/api/src/routers/<domain>.ts`
4. Add the REST gateway route in `apps/api/src/rest-gateway.ts`
5. The cloud extensions pick up new commands automatically (they delegate to
   the binary with pass-through args, so no extension changes are needed)

## Build

```bash
bazel build //apps/cli:monok8s
# or:
go build -o monok8s ./apps/cli
```

Release binaries are built for linux/amd64, linux/arm64, darwin/amd64,
darwin/arm64, windows/amd64 via the Tekton CI pipeline.
