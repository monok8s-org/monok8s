package main

// Activity stubs for the onboarding worker (#84 PR-A).
//
// Every activity function referenced by the four workflow files in
// this package (workflow.go, workflow_grant.go, workflow_installation.go,
// workflow_user.go) is declared here. Implementations return
// `errNotImplemented` so the package compiles and unit tests can
// exercise workflow orchestration without depending on real I/O —
// real implementations land in #84 PR-B (Crossplane XR submission
// via k8s client-go, Argo Workflow submission, Vault client, SpiceDB
// client, NATS publisher).
//
// Stubs return errors rather than nil-success so workflow-level tests
// exercise the error-propagation path AND don't accidentally claim
// success against unimplemented infrastructure.

import (
	"context"
	"errors"
)

// errNotImplemented is the sentinel every stub returns. Production
// activities replace this with real I/O in #84 PR-B.
var errNotImplemented = errors.New("activity not implemented — pending #84 PR-B real integration")

// ── OnboardTenantWorkflow activities (5 forward + 4 cleanup) ─────────────
//
// Forward (steps 1-5 per #84 AC):
//   - ProvisionNamespaceActivity + ProvisionDatabaseActivity      → activities_xr.go (#127)
//   - MintTenantVaultKeyActivity + RunMigrationsActivity          → activities_argo.go (#128)
//   - EmitTenantCreatedEventActivity                              → activities_emit.go (#126)
//
// Compensation cleanup (per #129a, invoked in reverse order on failure):
//   - DeleteTenantNamespaceActivity + DeleteTenantDatabaseActivity → activities_cleanup.go
//   - DeleteTenantVaultKeyActivity (stub; needs delete-tenant-vault-key WorkflowTemplate)
//   - EmitTenantCreationFailedEventActivity                       → activities_cleanup.go
//
// RunMigrationsActivity has no cleanup activity — Atlas no-rollback
// (Gap-logged in Discussion #45). DeleteTenantDatabaseActivity's drop
// renders the migration moot in practice.

// ── Legacy OnboardTenantWorkflow activity names ──────────────────────────
//
// The pre-#84 scaffolding of workflow.go included Zitadel / SpiceDB /
// OpenMeter steps. The new OnboardTenantWorkflow shape per #84's AC
// drops them, but the helper activity functions stay declared here as
// stubs so future Tier-2/3 workflows (#87 principal mutation, #89
// JWT/SpiceDB middleware, billing) can reference them without
// rebuilding the activity registration surface.

func CreateZitadelOrgActivity(_ context.Context, _ TenantInput) error {
	return errNotImplemented
}

func WritePermissionsActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

func RegisterMeteringActivity(_ context.Context, _ TenantInput) error {
	return errNotImplemented
}

// ── RegisterUserWorkflow / ErasureWorkflow activities (workflow_user.go) ─

func ProvisionVaultKeyActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

func WritePIIActivity(_ context.Context, _ UserInput) error {
	return errNotImplemented
}

func WriteUserEventActivity(_ context.Context, _ UserInput) error {
	return errNotImplemented
}

func WriteUserSpiceDBActivity(_ context.Context, _ string) (string, error) {
	return "", errNotImplemented
}

func WriteMemberSpiceDBActivity(_ context.Context, _ MemberSpiceDBInput) (string, error) {
	return "", errNotImplemented
}

func WriteMemberEventActivity(_ context.Context, _ MemberEventInput) error {
	return errNotImplemented
}

func WriteUserDeletedEventActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

func DeleteVaultKeyActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

func DeletePIIRowActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

func RevokeZitadelUserActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

func RemoveUserSpiceDBActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

// ── TemporaryGrantWorkflow activities (workflow_grant.go) ────────────────

func RemoveGrantSpiceDBActivity(_ context.Context, _ RemoveGrantSpiceDBInput) error {
	return errNotImplemented
}

func UpdateGrantStatusActivity(_ context.Context, _ UpdateGrantStatusInput) error {
	return errNotImplemented
}

// ── InstallationRegistrationWorkflow / Revocation / HeartbeatMonitor (workflow_installation.go) ─

func ValidateBootstrapTokenActivity(_ context.Context, _ ValidateBootstrapTokenInput) error {
	return errNotImplemented
}

func IssueInstallationCertActivity(_ context.Context, _ string) (IssuedCert, error) {
	return IssuedCert{}, errNotImplemented
}

func GenerateInstallationAPIKeyActivity(_ context.Context, _ string) (string, error) {
	return "", errNotImplemented
}

func WriteInstallationSpiceDBActivity(_ context.Context, _ WriteInstallationSpiceDBInput) error {
	return errNotImplemented
}

func ActivateInstallationActivity(_ context.Context, _ ActivateInstallationInput) error {
	return errNotImplemented
}

func UpdateInstallationHeartbeatActivity(_ context.Context, _ UpdateHeartbeatInput) error {
	return errNotImplemented
}

func FireInstallationAlertActivity(_ context.Context, _ FireAlertInput) error {
	return errNotImplemented
}

func SignalHeartbeatMonitorActivity(_ context.Context, _ SignalMonitorInput) error {
	return errNotImplemented
}

func RevokeInstallationCertActivity(_ context.Context, _ string) error {
	return errNotImplemented
}

func RevokeInstallationSpiceDBActivity(_ context.Context, _ RevokeInstallationSpiceDBInput) error {
	return errNotImplemented
}

func MarkInstallationRevokedActivity(_ context.Context, _ string) error {
	return errNotImplemented
}
