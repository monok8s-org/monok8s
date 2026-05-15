# packages/cloud-adapters/

Four runtime adapter axes per [Discussion #76](https://github.com/monok8s-org/monok8s-dev/discussions/76) — `storage`, `secrets`, `database`, `observability`. Each axis defines one **TypeScript** + one **Go** interface and four implementations (`baremetal` / `aws` / `gcp` / `azure`).

## Pattern

```
packages/cloud-adapters/<axis>/
├── BUILD.bazel
├── interface.ts        — canonical interface (TS)
├── interface.go        — canonical interface (Go)
├── baremetal.ts/.go    — bare-metal impl (MinIO / Vault / CNPG / Loki+Mimir+Tempo)
├── aws.ts/.go          — AWS impl (S3 / Secrets Manager / RDS / CloudWatch+X-Ray)
├── gcp.ts/.go          — GCP impl (GCS / Secret Manager / Cloud SQL / Cloud Logging+Trace)
├── azure.ts/.go        — Azure impl (Blob / Key Vault / Azure DB / Azure Monitor+App Insights)
└── contract_test.ts    — type-level conformance check; all four impls satisfy the interface
```

## Contract-test rule

Every axis MUST keep all four impls registered in `contract_test.ts`. The
`ts_project` typecheck enforces that each impl satisfies the canonical
interface — adding a method to the interface without adapting every impl
fails the build. This is the project-level "contract-test rule" in
[`/CLAUDE.md`](/CLAUDE.md) `## Overrides`.

## Scaffold status (#80)

- Every impl is a **stub** that throws `NotImplementedError` on call.
  Interface conformance is type-enforced; runtime behavior is asserted by
  the per-axis follow-up Issues that ship the real bare-metal wiring:
  - storage / MinIO       → #102
  - secrets / Vault       → #103
  - database / CNPG       → #104
  - observability / OTel  → #105
- AWS / GCP / Azure impls stay stubs until cloud-specific milestones add them.

## Adding a new method

1. Add the method to `interface.{ts,go}`.
2. Implement it (or stub-throw it) in every impl file.
3. Don't touch `contract_test.ts` — adding methods to the interface
   automatically forces every impl to comply on next `bazel build`.

## Adding a new axis

1. Create `packages/cloud-adapters/<name>/` mirroring the layout above.
2. Add the `## Overrides` entry in `/CLAUDE.md` pointing at the new axis.
3. File one bare-metal-impl follow-up Issue per axis (see #80's sub-issues).
