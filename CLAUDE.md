# monok8s

Cloud-neutral K8s-hosted SaaS. Single monorepo — apps, infra, platform config, frontend.

## Skill Reference

This project uses the forge-manager skill at
`.claude/skills/forge-manager/SKILL.md`. **At session start, before
responding to user input, invoke `/forge-manager` to engage the
protocol.** All conversation thereafter follows the recording,
classification, and session-lifecycle protocol the skill defines —
every turn recorded to the configured forge backends (per
`.claude/forge-config.json` `platforms`: local canonical at
`~/monok8s-docs`, GitHub mirror at `monok8s-org/monok8s-dev`).

The skill is installed project-level under `.claude/skills/`, so the
bare `/forge-manager` form resolves. The plugin-namespaced form
`/forge-manager:forge-manager` only works when forge-manager is also
installed via `/plugin install` — switch to it (or include both) if
this project ever adopts the plugin install path.

Project-specific commit-protocol extensions live in `## Overrides`
below. The 3.2.0+ protocol prefers these in `.claude/project-rules.md`;
running `audit_project_prose` will identify the migration candidates
when you're ready to split.

## Quick start
```bash
./tools/scripts/dev-setup.sh
```

## Key commands
```bash
bazel test //...                                        # run all tests (incremental)
bazel build //...                                       # build everything
docker compose -f docker-compose.deps.yaml up -d       # start local deps
tilt up                                                 # full K8s local mode (requires kind)
tilt up -- observability                                # full mode + Loki/Grafana/Prometheus
atlas migrate apply --config packages/db/atlas.hcl --env staging  # run migrations
```

## Stack
- **Build**:        Bazel + BuildBuddy remote cache
- **Frontend**:     SolidJS SPA, esbuild (prod), Vite (dev only)
- **API**:          TypeScript + tRPC
- **Workers**:      Go + Temporal
- **K8s**:          Kubernetes + Capsule (namespace tenancy)
- **IaC**:          Crossplane (tenant infra) + Terraform (bootstrap only)
- **GitOps**:       ArgoCD + Argo Rollouts + Kayenta
- **CI**:           GitHub Actions (PR checks) + Tekton (prod build/push)
- **AuthN**:        Zitadel
- **AuthZ**:        SpiceDB
- **Secrets**:      Vault + External Secrets Operator
- **Observability**: Loki + Mimir + Tempo + Grafana + OTel

## Critical ownership boundaries

| Owner | Scope | Never |
|---|---|---|
| Terraform | Bootstrap only (VPCs, clusters, IAM) | Run post-bootstrap on live env |
| Crossplane | All tenant-facing infra | Manage anything Terraform owns |
| ArgoCD | Manifest sync | Trigger deploys outside Tekton→git→ArgoCD |
| Tekton | Production CI (build, sign, push) | Run in PR checks |
| GitHub Actions | PR checks only | Build or push production images |
| Temporal | Business workflows (sagas, onboarding, billing) | Orchestrate deploys |
| Argo Rollouts | Canary/blue-green execution | Run business logic |

## Local service endpoints (fast mode)
| Service | URL | Credentials |
|---|---|---|
| API | http://localhost:3000 | — |
| Frontend | http://localhost:5173 | — |
| Temporal UI | http://localhost:8233 | — |
| Vault | http://localhost:8200 | token: `dev-root` |
| Zitadel | http://localhost:8080 | admin setup on first run |
| Tilt UI | http://localhost:10350 | full mode only |

## Project Identity

- Public repo: monok8s-org/monok8s
- Private repo: monok8s-org/monok8s-dev
- Docs repo: monok8s-org/monok8s-docs (local at ~/monok8s-docs)
- Account type: org
- Project board: https://github.com/orgs/monok8s-org/projects/1
- Bootstrapped: 2026-04-26
- Skill version at bootstrap: 2.0.0a2

## Overrides

These extend the forge-manager commit protocol with project-level
rules for **code-touching changes**. They do not replace the skill
protocol's linked-Issue requirement (which applies to every commit
regardless of content); both apply where in scope.

### Scope: when the test rules apply

Both rules below apply when a PR or commit touches **code, build
configuration, runtime manifests, or CI workflows**. Specifically:

- Application source — `apps/**`, `packages/**`, `frontend/**`, anything
  Go / TypeScript / Python / shell that runs at compile or runtime.
- Build configuration — `*.bzl`, `BUILD.bazel`, `MODULE.bazel`,
  `package.json`, `tsconfig.json`, `babel.config.js`, `jest.config.js`,
  `.bazelrc`, `tools/scripts/**`.
- Runtime manifests — `infra/**`, `platform/**`, `config/**`, `Tiltfile`,
  `docker-compose.deps.yaml`.
- CI — `.github/workflows/**`.
- Database migrations — `**/migrations/*.sql`.

**Exempt** — PRs / commits whose changes are confined entirely to:

- Documentation — any `*.md` file, including this `CLAUDE.md`, the
  per-directory `CLAUDE.md` files, `README.md`, and `docs/**`.
- Project metadata — `LICENSE`, `.gitignore`, `.editorconfig`,
  `CODEOWNERS`.
- Skill state and memory — `.claude/**`, `MEMORY.md`.
- Issue / Discussion templates — `.github/ISSUE_TEMPLATE/**`,
  `.github/DISCUSSION_TEMPLATE/**`.
- Auto-generated lockfiles — `MODULE.bazel.lock`, `pnpm-lock.yaml`,
  `go.sum`.

A mixed PR (any in-scope file touched, even one) is **not** exempt — the
rules apply to the whole PR.

### Test coverage with logged exception

When in scope (per above), every PR must EITHER:

- Cover all newly-added or newly-modified executable lines with tests at
  the L-tier appropriate to the component (L1 unit / L2 single-server
  hermetic / L3 multi-server `rules_itest` / L4 `rules_kind` cluster —
  see [Discussion #3](https://github.com/monok8s-org/monok8s-dev/discussions/3)
  for the per-component layer mapping); OR
- Append a `## Gap N — <short title>` entry to the **test-coverage running
  log** at [Discussion #45](https://github.com/monok8s-org/monok8s-dev/discussions/45)
  (Announcements) explaining what's not covered, why, and the conditions
  to close the gap.

The "tests added" claim must be specific: name the test files added, the
L-tier, and what they exercise. PR descriptions that say only "tests
added" do not satisfy this rule.

### All tests passing before commit

Before any in-scope `git commit`, all relevant tests must pass. Run
`bazel test //...` and confirm exit 0. If `//...` cannot resolve due to
known infrastructure gaps logged in Discussion #45, run the largest
invocable subset; the rule is satisfied when that subset passes AND the
gap is logged. If a test is intentionally skipped or marked broken, the
skip annotation must reference the gap entry in the running log.

This rule applies to every in-scope commit, not just merge commits.
Exempt commits (per the scope list above) are not required to run the
test suite.

### Bazel-only test surface

Every test in this project must be a **Bazel-managed target** — a
`*_test` rule consumed by `bazel test`. Examples: `go_test`,
`solid_test`, `jest_test`, `py_test`, `analysistest`, plus the
collider-bazel-extensions / `rules_itest` / `rules_kind` family
(`pg_test`, `temporal_test`, `rules_kubernetes` envtest,
`itest_suite`, `rules_kind` E2E).

Non-Bazel test invocations are **not** part of the project test surface.
That includes (but is not limited to): `go test ./...`, `pytest`,
`jest` / `npm test`, direct `vitest`, ad-hoc shell scripts that
exercise behavior, manual `curl`-based smoke tests. These may be
useful for local-iteration speed, but:

- They do not satisfy the test-coverage rule above (only Bazel `*_test`
  targets do).
- They must not appear in CI workflows, `.github/workflows/**`, or
  the project's commit-gate procedures.
- They must not be referenced as the test surface in PR descriptions.

The hermetic mechanism per stack layer is named in
[Discussion #4](https://github.com/monok8s-org/monok8s-dev/discussions/4)
— that table is authoritative for which `*_test` rule is appropriate
per component.

If a test cannot be expressed as a Bazel target — for example, a
test that requires an unsandboxable host capability not yet wrapped
by a `rules_*` provider — log a Gap entry in Discussion #45 naming
what blocks the Bazel-target form and the conditions under which it
could become Bazel-managed. The escape hatch is the gap log, not an
exception.

### Bazel-coverage gap surfacing

When development work encounters a tool, package, language, or
resource that lacks Bazel support — for example, a CLI not wrapped
by an existing `rules_*` provider, an npm/PyPI/crates package
without a corresponding Bazel toolchain, or a host-binary
dependency that breaks hermeticity — surface it to the user **at
the next stopping point in the elsewhere-development**. Don't let
the gap pass silently, and don't batch up multiple gaps to report
at session end.

A "stopping point" = any natural pause in the work flow: end of
a task, before opening a PR, before merging, when waiting for
user direction on the next step, when handing back to the user
for any reason. As soon as one of those arrives, raise the
gap before continuing.

The note must include:

- **What** lacks Bazel support — specific tool / package / language
  / resource by name and version (e.g. "pnpm 9.15.0 itself, not
  just the deps it manages").
- **Where** it was encountered — the file, command, or scenario
  that surfaced it (e.g. "encountered while running `pnpm install`
  for #39; required `npm install -g --prefix=…` since corepack is
  also absent from the Fedora node package").
- **Workaround** used (if any) — the path that let the immediate
  task proceed (e.g. "user-prefix npm install put pnpm at
  `~/.npm-global/bin/pnpm`; documented in PR body").
- **Recommendation** — pick one: (a) add a Bazel rule (and where
  — `collider-bazel-extensions` for cross-project rules,
  `tools/bazel/` for monok8s-only macros); (b) accept and gap-log
  in [Discussion #4](https://github.com/monok8s-org/monok8s-dev/discussions/4)
  (Hermeticity) for build/test surface, or
  [Discussion #45](https://github.com/monok8s-org/monok8s-dev/discussions/45)
  (Test coverage) when test-related; (c) accept as a documented
  host-binary requirement.

Why: hermeticity is a project design principle (Discussion #4).
Silent acceptance of Bazel-coverage gaps drifts the project away
from that principle without an explicit decision. The user owns
the choice between writing a new rule, filing an upstream Issue
against `collider-bazel-extensions`, and accepting the gap; the
surfacing rule guarantees they get the choice.

### Cloud-adapter contract-test rule

The four cloud-adapter axes at `packages/cloud-adapters/{storage,
secrets,database,observability}/` define the project's storage /
secrets / database / observability boundary surfaces. Each axis ships
**one TypeScript + one Go interface** and **four implementations** —
`baremetal` / `aws` / `gcp` / `azure`.

Two invariants apply to every axis:

- **Interface conformance is statically enforced.** Each axis has a
  `contract_test.ts` that registers all four implementations as a
  `Record<…, AxisAdapter>`. The `ts_project` typecheck fails if any
  implementation stops satisfying the canonical interface — adding
  a method to the interface forces every implementation to comply on
  next `bazel build`.

- **Adding an implementation requires updating the contract registry.**
  A new implementation that omits itself from `contract_test.ts`
  bypasses the interface check. CI surfaces this via the `ts_project`
  typecheck on the axis target.

The Go side ships .go files alongside; `go_library` wiring lands when
the first consumer (apps/api or apps/workers) gets its `BUILD.bazel`
per the Discussion #45 Gap 1 cleanup. Same pattern as `packages/auth/go`.

Per-axis bare-metal real implementations land in #102 (storage / MinIO),
#103 (secrets / Vault Transit), #104 (database / CNPG), and #105
(observability / Loki+Mimir+Tempo). Cloud implementations stay stubs
until their respective cloud-install milestones.
