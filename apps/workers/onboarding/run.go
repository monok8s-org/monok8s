package main

import (
	"os"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

// TaskQueueName matches the directory name per apps/workers/CLAUDE.md
// ("Task queue name matches the worker directory name exactly").
const TaskQueueName = "onboarding"

// run connects to a Temporal server (env-var TEMPORAL_ADDRESS, default
// `temporal.temporal.svc.cluster.local:7233`), registers every
// workflow + activity, and runs the worker on the `onboarding` task
// queue. Returns when the worker receives SIGTERM / SIGINT, or if
// the Temporal connection fails on startup.
//
// PR-A's activities all return `errNotImplemented`; the worker
// compiles and runs but no workflow can complete successfully until
// #124 sub-PRs 2-4 land the real activity implementations
// (NATS publish, Crossplane XR submission, Argo Workflow submission).
// The OCI image produced by //apps/workers/onboarding:image is
// therefore non-functional in production today — that's expected
// for sub-PR-1's scope. Sub-PR-5 ships the L2 itest that proves
// the full chain.
func run() error {
	addr := os.Getenv("TEMPORAL_ADDRESS")
	if addr == "" {
		addr = "temporal.temporal.svc.cluster.local:7233"
	}

	// TEMPORAL_NAMESPACE override — required for the L2 replay_test
	// target (rules_temporal's launcher creates a unique namespace per
	// run and expects the worker to register pollers there). Empty
	// string is Temporal's "default" namespace, used in production.
	c, err := client.Dial(client.Options{
		HostPort:  addr,
		Namespace: os.Getenv("TEMPORAL_NAMESPACE"),
	})
	if err != nil {
		return err
	}
	defer c.Close()

	w := worker.New(c, TaskQueueName, worker.Options{})

	// ── Workflows ─────────────────────────────────────────────────────
	w.RegisterWorkflow(OnboardTenantWorkflow)
	w.RegisterWorkflow(RegisterUserWorkflow)
	w.RegisterWorkflow(ErasureWorkflow)
	w.RegisterWorkflow(TemporaryGrantWorkflow)
	w.RegisterWorkflow(InstallationRegistrationWorkflow)
	w.RegisterWorkflow(InstallationHeartbeatMonitorWorkflow)
	w.RegisterWorkflow(InstallationRevocationWorkflow)
	// Tenant-role grant/revoke (#232 — PR-1 of roles.assign chain):
	w.RegisterWorkflow(TenantRoleAssignWorkflow)
	w.RegisterWorkflow(TenantRoleUnassignWorkflow)
	// Tenant-role swap (#236):
	w.RegisterWorkflow(TenantRoleChangeWorkflow)
	// Group membership (#248):
	w.RegisterWorkflow(TenantGroupMemberAddWorkflow)
	w.RegisterWorkflow(TenantGroupMemberRemoveWorkflow)
	// User suspend/reinstate (#252):
	w.RegisterWorkflow(TenantUserSuspendWorkflow)
	w.RegisterWorkflow(TenantUserReinstateWorkflow)

	// ── Activities (every function in activities.go) ─────────────────
	// Workflow status emit (#177 / #88b) — scheduled by every workflow
	// that wires emitWorkflowLifecycle / emitStep at phase boundaries.
	w.RegisterActivity(EmitWorkflowStatusActivity)
	// OnboardTenantWorkflow forward path (#84):
	w.RegisterActivity(ProvisionNamespaceActivity)
	w.RegisterActivity(ProvisionDatabaseActivity)
	w.RegisterActivity(MintTenantVaultKeyActivity)
	w.RegisterActivity(RunMigrationsActivity)
	w.RegisterActivity(EmitTenantCreatedEventActivity)
	// OnboardTenantWorkflow compensation cleanup (#129a):
	w.RegisterActivity(DeleteTenantNamespaceActivity)
	w.RegisterActivity(DeleteTenantDatabaseActivity)
	w.RegisterActivity(DeleteTenantVaultKeyActivity)
	w.RegisterActivity(EmitTenantCreationFailedEventActivity)
	// Legacy tenant-onboarding scaffolding (kept for future Tier-2/3 reuse):
	w.RegisterActivity(CreateZitadelOrgActivity)
	w.RegisterActivity(WritePermissionsActivity)
	w.RegisterActivity(RegisterMeteringActivity)
	// RegisterUserWorkflow + ErasureWorkflow:
	w.RegisterActivity(ProvisionVaultKeyActivity)
	w.RegisterActivity(WritePIIActivity)
	w.RegisterActivity(WriteUserEventActivity)
	w.RegisterActivity(WriteUserSpiceDBActivity)
	w.RegisterActivity(WriteMemberSpiceDBActivity)
	w.RegisterActivity(WriteMemberEventActivity)
	w.RegisterActivity(WriteUserDeletedEventActivity)
	w.RegisterActivity(DeleteVaultKeyActivity)
	w.RegisterActivity(DeletePIIRowActivity)
	w.RegisterActivity(RevokeZitadelUserActivity)
	w.RegisterActivity(RemoveUserSpiceDBActivity)
	// TemporaryGrantWorkflow:
	w.RegisterActivity(RemoveGrantSpiceDBActivity)
	w.RegisterActivity(UpdateGrantStatusActivity)
	// InstallationRegistration / HeartbeatMonitor / Revocation:
	w.RegisterActivity(ValidateBootstrapTokenActivity)
	w.RegisterActivity(IssueInstallationCertActivity)
	w.RegisterActivity(GenerateInstallationAPIKeyActivity)
	w.RegisterActivity(WriteInstallationSpiceDBActivity)
	w.RegisterActivity(ActivateInstallationActivity)
	w.RegisterActivity(UpdateInstallationHeartbeatActivity)
	w.RegisterActivity(FireInstallationAlertActivity)
	w.RegisterActivity(SignalHeartbeatMonitorActivity)
	w.RegisterActivity(RevokeInstallationCertActivity)
	w.RegisterActivity(RevokeInstallationSpiceDBActivity)
	w.RegisterActivity(MarkInstallationRevokedActivity)
	// TenantRoleAssign/UnassignWorkflows (#232):
	w.RegisterActivity(AssignTenantRoleSpiceDBActivity)
	w.RegisterActivity(UnassignTenantRoleSpiceDBActivity)
	// TenantRoleChangeWorkflow (#236):
	w.RegisterActivity(ChangeTenantRoleSpiceDBActivity)
	// TenantGroupMember Add/Remove workflows (#248):
	w.RegisterActivity(AddGroupMemberSpiceDBActivity)
	w.RegisterActivity(RemoveGroupMemberSpiceDBActivity)
	// TenantUserSuspend/Reinstate workflows (#252):
	w.RegisterActivity(SuspendMemberSpiceDBActivity)
	w.RegisterActivity(ReinstateMemberSpiceDBActivity)

	return w.Run(worker.InterruptCh())
}
