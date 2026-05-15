package main

import (
	"time"

	"go.temporal.io/sdk/workflow"
)

type TenantInput struct {
	TenantID string
	Email    string
	Plan     string
}

// Workflow type identifier published on the workflow.<wid>.status NATS
// stream (#177 / #88b). Tenant-built workflows will use their own
// type strings; platform workflows hardcode "monok8s.<name>".
const (
	onboardingWorkflowType = "monok8s.onboarding"

	stepProvisionNamespace = "provision_namespace"
	stepProvisionDatabase  = "provision_database"
	stepMintVaultKey       = "mint_vault_key"
	stepRunMigrations      = "run_migrations"
	stepEmitTenantCreated  = "emit_tenant_created"
)

// statusEmitsChangeID gates the workflow-status emissions behind a
// Temporal GetVersion patch (#177). Old recorded histories captured
// before #177 see DefaultVersion and skip all emits; new executions
// see v1 and schedule the emit activities. Without this gate, the
// :replay_test target fails non-determinism — adding activity calls
// to the schedule sequence breaks old histories.
//
// Per the Temporal patching guide, the change ID is stable for the
// lifetime of this patch. When all old histories have expired (or
// been regenerated), a follow-up may bump the change to v2 / collapse
// the gate; that's a separate concern from this Issue.
const statusEmitsChangeID = "issue-177-workflow-status-emits"

// emitWorkflowLifecycle publishes a workflow-scope status event
// (started / succeeded / failed / cancelled). Best-effort: errors are
// intentionally ignored — status emission must not poison the
// workflow's primary outcome. Gated by statusEmitsChangeID so old
// recorded histories replay cleanly.
func emitWorkflowLifecycle(ctx workflow.Context, workflowID, tenantID, phase, errMsg string) {
	if workflow.GetVersion(ctx, statusEmitsChangeID, workflow.DefaultVersion, 1) < 1 {
		return
	}
	_ = workflow.ExecuteActivity(ctx, EmitWorkflowStatusActivity, WorkflowStatusEvent{
		Scope:        "workflow",
		WorkflowID:   workflowID,
		WorkflowType: onboardingWorkflowType,
		TenantID:     tenantID,
		Phase:        phase,
		Timestamp:    workflow.Now(ctx).UTC().Format(time.RFC3339Nano),
		Error:        errMsg,
	}).Get(ctx, nil)
}

// emitStep publishes a step-scope status event. Same gate +
// best-effort semantics as emitWorkflowLifecycle.
func emitStep(ctx workflow.Context, workflowID, tenantID, step, phase, errMsg string) {
	if workflow.GetVersion(ctx, statusEmitsChangeID, workflow.DefaultVersion, 1) < 1 {
		return
	}
	_ = workflow.ExecuteActivity(ctx, EmitWorkflowStatusActivity, WorkflowStatusEvent{
		Scope:        "step",
		WorkflowID:   workflowID,
		WorkflowType: onboardingWorkflowType,
		TenantID:     tenantID,
		Step:         step,
		Phase:        phase,
		Timestamp:    workflow.Now(ctx).UTC().Format(time.RFC3339Nano),
		Error:        errMsg,
	}).Get(ctx, nil)
}

// OnboardTenantWorkflow provisions a new tenant's per-tenant infrastructure
// end-to-end. Per Discussion #76 + Issue #84, this workflow is the
// Tier-2 orchestrator that drives the cluster-mutation steps shipped in
// #81 (Capsule tenant CR) + #82 (per-tenant CNPG) + #83 (per-tenant
// Vault transit key) + #86 (Atlas migrations).
//
// Steps (per #84 AC):
//
//  1. Provision the Capsule tenant CR + tenant namespace (#81).
//     Submits the XTenant XR via Crossplane; tenant-capsule
//     Composition reconciles a per-tenant Capsule `Tenant` CR + the
//     `tenant-<id>` namespace with policies.
//  2. Provision per-tenant Postgres (#82). Submits the XTenantDatabase
//     XR; tenant-database-cnpg Composition creates the CNPG Cluster
//     in the per-tenant namespace.
//  3. Mint per-tenant Vault transit key (#83). Submits the
//     `mint-tenant-vault-key` Argo WorkflowTemplate; creates
//     `transit/keys/tenant-<id>` with convergent_encryption + derived.
//  4. Run Atlas migrations against the per-tenant Postgres (#86).
//     Submits the `apply-tenant-migrations` Argo WorkflowTemplate.
//  5. Emit `tenant.created` event to NATS subject `tenant.<tid>.events`
//     so the UI / CLI live-tail subscriptions notice the tenant is
//     ready.
//
// # Compensation (per #129a)
//
// On any failure after step 1, the workflow invokes cleanup activities
// in reverse order of completion. Cleanup runs on a disconnected context
// (workflow.NewDisconnectedContext) so it survives parent cancellation.
// Each cleanup activity is idempotent — a 404 from the apiserver
// returns nil, so cleanup of an already-cleaned step is a no-op success.
// Cleanup errors are intentionally ignored (best-effort idiom; the
// failing forward activity's error is what propagates to the caller).
// After reverse-order cleanup, EmitTenantCreationFailedEventActivity
// publishes `tenant.creation-failed` so subscribers can react.
//
// Migration rollback (step 4) is intentionally skipped — Atlas does not
// support automatic downgrade; the downstream DeleteTenantDatabaseActivity
// drops the database, which renders the migration moot. Gap-logged in
// Discussion #45.
//
// # Determinism
//
// Per apps/workers/CLAUDE.md: every side effect is in an activity; no
// direct I/O, no time.Now, no goroutines. The `completed` slice is
// workflow-state (replay-deterministic). The cleanup closure captures
// `ctx` and `input.TenantID` by reference but invokes activities (which
// are the only place side effects happen).
func OnboardTenantWorkflow(ctx workflow.Context, input TenantInput) error {
	opts := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, opts)

	// Workflow ID for the status-event subject (#177). By project
	// convention every workflow ID starts with `tnt-<tenantUUID>-` so
	// the apps/api canOnWorkflow helper can parse the owning tenant
	// for authz. Producer side here just reads the live ID — the
	// caller (apps/api workflow-start site) is responsible for
	// supplying a tnt-prefixed ID.
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID

	emitWorkflowLifecycle(ctx, workflowID, input.TenantID, "started", "")

	// Track which forward activities have completed so the cleanup
	// closure knows which cleanup activities to invoke and in what
	// reverse order.
	var completed []string

	cleanup := func() {
		// Disconnected context so cleanup runs even if the parent
		// workflow was cancelled (e.g. operator killed the run).
		cleanupCtx, _ := workflow.NewDisconnectedContext(ctx)
		cleanupCtx = workflow.WithActivityOptions(cleanupCtx, workflow.ActivityOptions{
			StartToCloseTimeout: 5 * time.Minute,
		})

		for i := len(completed) - 1; i >= 0; i-- {
			switch completed[i] {
			case "namespace":
				_ = workflow.ExecuteActivity(cleanupCtx, DeleteTenantNamespaceActivity, input.TenantID).Get(cleanupCtx, nil)
			case "database":
				_ = workflow.ExecuteActivity(cleanupCtx, DeleteTenantDatabaseActivity, input.TenantID).Get(cleanupCtx, nil)
			case "vault-key":
				_ = workflow.ExecuteActivity(cleanupCtx, DeleteTenantVaultKeyActivity, input.TenantID).Get(cleanupCtx, nil)
			case "migrations":
				// Intentional no-op — Atlas no-rollback (Gap in Discussion #45).
				// DeleteTenantDatabaseActivity (already invoked above in
				// reverse order) drops the database, making the migration
				// moot in practice.
			}
		}

		// Emit failure event last so subscribers see it after cleanup is
		// best-effort done. Error ignored — already in a failure path.
		_ = workflow.ExecuteActivity(cleanupCtx, EmitTenantCreationFailedEventActivity, input.TenantID).Get(cleanupCtx, nil)
	}

	// Each step is bracketed by step-lifecycle emissions. Production
	// code uses best-effort emit (errors ignored — see emit helpers).

	// 1. Capsule tenant CR + tenant namespace (#81).
	emitStep(ctx, workflowID, input.TenantID, stepProvisionNamespace, "started", "")
	if err := workflow.ExecuteActivity(ctx, ProvisionNamespaceActivity, input.TenantID).Get(ctx, nil); err != nil {
		emitStep(ctx, workflowID, input.TenantID, stepProvisionNamespace, "failed", err.Error())
		emitWorkflowLifecycle(ctx, workflowID, input.TenantID, "failed", err.Error())
		return err // nothing to clean up
	}
	emitStep(ctx, workflowID, input.TenantID, stepProvisionNamespace, "succeeded", "")
	completed = append(completed, "namespace")

	// 2. Per-tenant Postgres (#82).
	emitStep(ctx, workflowID, input.TenantID, stepProvisionDatabase, "started", "")
	if err := workflow.ExecuteActivity(ctx, ProvisionDatabaseActivity, input.TenantID).Get(ctx, nil); err != nil {
		emitStep(ctx, workflowID, input.TenantID, stepProvisionDatabase, "failed", err.Error())
		cleanup()
		emitWorkflowLifecycle(ctx, workflowID, input.TenantID, "failed", err.Error())
		return err
	}
	emitStep(ctx, workflowID, input.TenantID, stepProvisionDatabase, "succeeded", "")
	completed = append(completed, "database")

	// 3. Per-tenant Vault transit key (#83).
	emitStep(ctx, workflowID, input.TenantID, stepMintVaultKey, "started", "")
	if err := workflow.ExecuteActivity(ctx, MintTenantVaultKeyActivity, input.TenantID).Get(ctx, nil); err != nil {
		emitStep(ctx, workflowID, input.TenantID, stepMintVaultKey, "failed", err.Error())
		cleanup()
		emitWorkflowLifecycle(ctx, workflowID, input.TenantID, "failed", err.Error())
		return err
	}
	emitStep(ctx, workflowID, input.TenantID, stepMintVaultKey, "succeeded", "")
	completed = append(completed, "vault-key")

	// 4. Atlas migrations (#86).
	emitStep(ctx, workflowID, input.TenantID, stepRunMigrations, "started", "")
	if err := workflow.ExecuteActivity(ctx, RunMigrationsActivity, input.TenantID).Get(ctx, nil); err != nil {
		emitStep(ctx, workflowID, input.TenantID, stepRunMigrations, "failed", err.Error())
		cleanup()
		emitWorkflowLifecycle(ctx, workflowID, input.TenantID, "failed", err.Error())
		return err
	}
	emitStep(ctx, workflowID, input.TenantID, stepRunMigrations, "succeeded", "")
	completed = append(completed, "migrations")

	// 5. Emit tenant.created event to NATS.
	emitStep(ctx, workflowID, input.TenantID, stepEmitTenantCreated, "started", "")
	if err := workflow.ExecuteActivity(ctx, EmitTenantCreatedEventActivity, input.TenantID).Get(ctx, nil); err != nil {
		emitStep(ctx, workflowID, input.TenantID, stepEmitTenantCreated, "failed", err.Error())
		cleanup()
		emitWorkflowLifecycle(ctx, workflowID, input.TenantID, "failed", err.Error())
		return err
	}
	emitStep(ctx, workflowID, input.TenantID, stepEmitTenantCreated, "succeeded", "")

	emitWorkflowLifecycle(ctx, workflowID, input.TenantID, "succeeded", "")
	return nil
}
