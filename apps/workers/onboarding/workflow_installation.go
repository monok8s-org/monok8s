package main

import (
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/workflow"
)

// ── Registration ──────────────────────────────────────────────────────────────

type InstallationRegistrationInput struct {
	InstallationID   string
	TenantID         string
	BootstrapToken   string // plaintext — verified then discarded
	HostCloud        string
	HostRegion       string
}

type InstallationCredentials struct {
	// PEM-encoded client cert issued by Vault PKI (24h TTL)
	// cert-manager on Model B takes over rotation after this initial issuance.
	CertPEM    string
	CACertPEM  string
	// API key for alert webhook + heartbeat (longer-lived, rotatable)
	// Shown exactly once — not stored anywhere after this workflow completes.
	APIKey     string
	// OTel and alert endpoint URLs for this installation
	OTelEndpoint  string
	AlertEndpoint string
}

// InstallationRegistrationWorkflow validates the bootstrap token, issues
// credentials from Vault PKI, writes SpiceDB relations, and activates the
// installation record. Starts HeartbeatMonitorWorkflow as a child on success.
func InstallationRegistrationWorkflow(
	ctx workflow.Context,
	input InstallationRegistrationInput,
) (InstallationCredentials, error) {
	opts := workflow.ActivityOptions{StartToCloseTimeout: 2 * time.Minute}
	ctx = workflow.WithActivityOptions(ctx, opts)

	// 1. Validate and consume the bootstrap token (one-time use).
	if err := workflow.ExecuteActivity(ctx,
		ValidateBootstrapTokenActivity,
		ValidateBootstrapTokenInput{
			InstallationID: input.InstallationID,
			Token:          input.BootstrapToken,
		},
	).Get(ctx, nil); err != nil {
		return InstallationCredentials{}, err
	}

	// 2. Issue mTLS client certificate from Vault PKI.
	var cert IssuedCert
	if err := workflow.ExecuteActivity(ctx,
		IssueInstallationCertActivity,
		input.InstallationID,
	).Get(ctx, &cert); err != nil {
		return InstallationCredentials{}, err
	}

	// 3. Generate API key (for alerts + heartbeats).
	var apiKey string
	if err := workflow.ExecuteActivity(ctx,
		GenerateInstallationAPIKeyActivity,
		input.InstallationID,
	).Get(ctx, &apiKey); err != nil {
		return InstallationCredentials{}, err
	}

	// 4. Write SpiceDB installation relations.
	if err := workflow.ExecuteActivity(ctx,
		WriteInstallationSpiceDBActivity,
		WriteInstallationSpiceDBInput{
			InstallationID: input.InstallationID,
			TenantID:       input.TenantID,
		},
	).Get(ctx, nil); err != nil {
		return InstallationCredentials{}, err
	}

	// 5. Activate the DB record and store cert metadata + API key hash.
	if err := workflow.ExecuteActivity(ctx,
		ActivateInstallationActivity,
		ActivateInstallationInput{
			InstallationID: input.InstallationID,
			CertSerial:     cert.Serial,
			CertExpiresAt:  cert.ExpiresAt,
			APIKeyHash:     apiKey, // activity hashes it before storing
			HostCloud:      input.HostCloud,
			HostRegion:     input.HostRegion,
		},
	).Get(ctx, nil); err != nil {
		return InstallationCredentials{}, err
	}

	// 6. Start the heartbeat monitor as a detached child workflow.
	childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		WorkflowID: "heartbeat-monitor-" + input.InstallationID,
		// No parent cancellation propagation — monitor outlives registration workflow.
		ParentClosePolicy: enumspb.PARENT_CLOSE_POLICY_ABANDON,
	})
	workflow.ExecuteChildWorkflow(childCtx, InstallationHeartbeatMonitorWorkflow, input.InstallationID)

	return InstallationCredentials{
		CertPEM:       cert.CertPEM,
		CACertPEM:     cert.CAPEM,
		APIKey:        apiKey,
		OTelEndpoint:  "https://telemetry.monok8s.io/v1/" + input.InstallationID,
		AlertEndpoint: "https://api.monok8s.io/trpc/installations.ingestAlerts",
	}, nil
}

// ── Heartbeat monitor ─────────────────────────────────────────────────────────

// InstallationHeartbeatMonitorWorkflow runs for the lifetime of an installation.
// It receives heartbeat signals from the Model B install and escalates alerts
// when heartbeats are missed.
//
// Signals:
//   "heartbeat" — sent by Model B on each successful heartbeat POST
//   "revoke"    — sent by InstallationRevocationWorkflow to stop the monitor
func InstallationHeartbeatMonitorWorkflow(ctx workflow.Context, installationID string) error {
	heartbeatSignal := workflow.GetSignalChannel(ctx, "heartbeat")
	revokeSignal := workflow.GetSignalChannel(ctx, "revoke")

	const (
		warningAfter  = 10 * time.Minute
		criticalAfter = 30 * time.Minute
	)

	actOpts := workflow.ActivityOptions{StartToCloseTimeout: 30 * time.Second}
	actCtx := workflow.WithActivityOptions(ctx, actOpts)

	status := "healthy"

	for {
		var timerFired, heartbeatReceived, revoked bool
		var nextThreshold time.Duration
		if status == "healthy" {
			nextThreshold = warningAfter
		} else {
			nextThreshold = criticalAfter - warningAfter
		}

		timerCtx, cancelTimer := workflow.WithCancel(ctx)
		timer := workflow.NewTimer(timerCtx, nextThreshold)

		workflow.Go(ctx, func(gCtx workflow.Context) {
			_ = timer.Get(gCtx, nil)
			timerFired = true
		})
		workflow.Go(ctx, func(gCtx workflow.Context) {
			heartbeatSignal.Receive(gCtx, nil)
			heartbeatReceived = true
			cancelTimer()
		})
		workflow.Go(ctx, func(gCtx workflow.Context) {
			revokeSignal.Receive(gCtx, nil)
			revoked = true
			cancelTimer()
		})

		_ = workflow.Await(ctx, func() bool {
			return timerFired || heartbeatReceived || revoked
		})

		if revoked {
			return nil
		}

		if heartbeatReceived {
			if status != "healthy" {
				// Recovered — clear the alert
				_ = workflow.ExecuteActivity(actCtx,
					UpdateInstallationHeartbeatActivity,
					UpdateHeartbeatInput{InstallationID: installationID, Status: "healthy"},
				).Get(actCtx, nil)
				status = "healthy"
			} else {
				_ = workflow.ExecuteActivity(actCtx,
					UpdateInstallationHeartbeatActivity,
					UpdateHeartbeatInput{InstallationID: installationID, Status: "healthy"},
				).Get(actCtx, nil)
			}
			continue
		}

		// Timer fired — escalate
		newStatus := "warning"
		if status == "warning" {
			newStatus = "critical"
		}
		status = newStatus

		_ = workflow.ExecuteActivity(actCtx,
			UpdateInstallationHeartbeatActivity,
			UpdateHeartbeatInput{InstallationID: installationID, Status: newStatus},
		).Get(actCtx, nil)

		_ = workflow.ExecuteActivity(actCtx,
			FireInstallationAlertActivity,
			FireAlertInput{InstallationID: installationID, Severity: newStatus},
		).Get(actCtx, nil)

		if newStatus == "critical" {
			// Stop escalating — stay in critical until heartbeat or revocation.
			_ = workflow.Await(ctx, func() bool {
				var got bool
				heartbeatSignal.ReceiveAsync(&got)
				var rev bool
				revokeSignal.ReceiveAsync(&rev)
				return got || rev
			})
			if revoked {
				return nil
			}
			status = "healthy"
		}
	}
}

// ── Revocation ────────────────────────────────────────────────────────────────

// InstallationRevocationWorkflow revokes credentials and stops the heartbeat monitor.
func InstallationRevocationWorkflow(ctx workflow.Context, installationID string, tenantID string) error {
	opts := workflow.ActivityOptions{StartToCloseTimeout: 2 * time.Minute}
	ctx = workflow.WithActivityOptions(ctx, opts)

	// Signal the heartbeat monitor to stop.
	workflow.ExecuteActivity(ctx, SignalHeartbeatMonitorActivity,
		SignalMonitorInput{InstallationID: installationID, Signal: "revoke"},
	)

	// Revoke the Vault PKI cert (add to CRL).
	if err := workflow.ExecuteActivity(ctx,
		RevokeInstallationCertActivity, installationID,
	).Get(ctx, nil); err != nil {
		return err
	}

	// Remove SpiceDB relations.
	if err := workflow.ExecuteActivity(ctx,
		RevokeInstallationSpiceDBActivity,
		RevokeInstallationSpiceDBInput{InstallationID: installationID, TenantID: tenantID},
	).Get(ctx, nil); err != nil {
		return err
	}

	// Mark DB record as revoked.
	return workflow.ExecuteActivity(ctx,
		MarkInstallationRevokedActivity, installationID,
	).Get(ctx, nil)
}

// ── Activity input/output types ───────────────────────────────────────────────

type ValidateBootstrapTokenInput struct {
	InstallationID string
	Token          string
}

type IssuedCert struct {
	Serial    string
	ExpiresAt string // RFC3339
	CertPEM   string
	CAPEM     string
}

type WriteInstallationSpiceDBInput struct {
	InstallationID string
	TenantID       string
}

type RevokeInstallationSpiceDBInput struct {
	InstallationID string
	TenantID       string
}

type ActivateInstallationInput struct {
	InstallationID string
	CertSerial     string
	CertExpiresAt  string
	APIKeyHash     string
	HostCloud      string
	HostRegion     string
}

type UpdateHeartbeatInput struct {
	InstallationID string
	Status         string
}

type FireAlertInput struct {
	InstallationID string
	Severity       string
}

type SignalMonitorInput struct {
	InstallationID string
	Signal         string
}
