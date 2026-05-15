package billing

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ── Marketplace workflows ──────────────────────────────────────────────────────

// MeteringWorkflow runs hourly and submits usage records to all three cloud
// marketplaces. It fans out per-cloud in parallel so a single cloud API failure
// doesn't block the others.
//
// Scheduled via Temporal Schedule (see platform/marketplace/metering-schedule.yaml).
// Task queue: "billing"
func MeteringWorkflow(ctx workflow.Context) error {
	periodEnd := workflow.Now(ctx).UTC().Truncate(time.Hour)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    5 * time.Minute,
			MaximumAttempts:    5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Collect metering data once; writes pending DB rows for all marketplace tenants.
	var records []MarketplaceUsageRecord
	if err := workflow.ExecuteActivity(ctx, CollectMeteringDataActivity, periodEnd).Get(ctx, &records); err != nil {
		return err
	}
	if len(records) == 0 {
		return nil
	}

	// Group by cloud and submit in parallel.
	awsRecords, gcpRecords, azureRecords := splitByCloud(records)

	var awsErr, gcpErr, azureErr error
	awsFuture   := submitBatch(ctx, awsRecords,   SubmitAWSMeteringRecordActivity)
	gcpFuture   := submitBatch(ctx, gcpRecords,   SubmitGCPMeteringRecordActivity)
	azureFuture := submitBatch(ctx, azureRecords, SubmitAzureMeteringRecordActivity)

	awsErr   = awsFuture.Get(ctx, nil)
	gcpErr   = gcpFuture.Get(ctx, nil)
	azureErr = azureFuture.Get(ctx, nil)

	// Return the first non-nil error so Temporal retries the whole workflow.
	// Records already submitted are idempotent (cloud deduplicates on idempotency key).
	for _, err := range []error{awsErr, gcpErr, azureErr} {
		if err != nil {
			return err
		}
	}
	return nil
}

// MarketplaceOnboardWorkflow provisions a new tenant that arrived via a cloud
// marketplace subscription. Called from the OnboardTenantWorkflow when source
// is "aws_marketplace", "gcp_marketplace", or "azure_marketplace".
//
// For GCP: also approves the entitlement (must happen within 15 minutes).
// For Azure: confirms the subscribe operation via the Fulfillment API.
func MarketplaceOnboardWorkflow(ctx workflow.Context, input MarketplaceOnboardInput) error {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 60 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    5 * time.Second,
			BackoffCoefficient: 2.0,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    10, // GCP has a 15-minute window — 10 retries gives ~5 minutes
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	switch input.Source {
	case "gcp_marketplace":
		// Must approve within 15 minutes — run first before anything else.
		if err := workflow.ExecuteActivity(ctx,
			ApproveGCPEntitlementActivity, input.MarketplaceEntitlementID,
		).Get(ctx, nil); err != nil {
			return err
		}
	case "azure_marketplace":
		if err := workflow.ExecuteActivity(ctx,
			ConfirmAzureOperationActivity,
			input.MarketplaceSubscriptionID,
			input.MarketplaceOperationID,
			"Success",
		).Get(ctx, nil); err != nil {
			// Best-effort — Azure retries the webhook, don't block onboarding.
			workflow.GetLogger(ctx).Warn("failed to confirm Azure operation", "err", err)
		}
	}
	// AWS subscribe-success doesn't need explicit confirmation.
	return nil
}

// MarketplaceOffboardWorkflow handles cancellation/suspension triggered by a
// marketplace unsubscribe event. Signals the tenant's OffboardTenantWorkflow
// to start the grace-period countdown, then confirms the cloud operation.
func MarketplaceOffboardWorkflow(ctx workflow.Context, input MarketplaceOffboardInput) error {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 5 * time.Second,
			MaximumAttempts: 5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	if input.Source == "azure_marketplace" && input.MarketplaceOperationID != "" {
		_ = workflow.ExecuteActivity(ctx,
			ConfirmAzureOperationActivity,
			input.MarketplaceSubscriptionID,
			input.MarketplaceOperationID,
			"Success",
		).Get(ctx, nil)
	}
	return nil
}

// ── Input types ───────────────────────────────────────────────────────────────

type MarketplaceOnboardInput struct {
	TenantID                 string
	Source                   string
	MarketplaceCustomerID    string // AWS
	MarketplaceProductCode   string // AWS
	MarketplaceEntitlementID string // GCP
	MarketplaceAccountID     string // GCP
	MarketplaceSubscriptionID string // Azure
	MarketplaceOperationID   string // Azure
	Plan                     string
}

type MarketplaceOffboardInput struct {
	Source                    string
	MarketplaceCustomerID     string
	MarketplaceEntitlementID  string
	MarketplaceSubscriptionID string
	MarketplaceOperationID    string
	Reason                    string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func splitByCloud(records []MarketplaceUsageRecord) (aws, gcp, azure []MarketplaceUsageRecord) {
	for _, r := range records {
		switch r.Source {
		case "aws_marketplace":
			aws = append(aws, r)
		case "gcp_marketplace":
			gcp = append(gcp, r)
		case "azure_marketplace":
			azure = append(azure, r)
		}
	}
	return
}

type submitFn func(context workflow.Context, record MarketplaceUsageRecord) (string, error)

// submitBatch submits all records for one cloud sequentially in a child goroutine
// so the three cloud batches run in parallel from the caller's perspective.
// Returns a Future that resolves when all records in the batch are done (or one fails).
func submitBatch(ctx workflow.Context, records []MarketplaceUsageRecord, activityFn interface{}) workflow.Future {
	f, s := workflow.NewFuture(ctx)
	workflow.Go(ctx, func(ctx workflow.Context) {
		for _, r := range records {
			if err := workflow.ExecuteActivity(ctx, activityFn, r).Get(ctx, nil); err != nil {
				s.SetError(err)
				return
			}
		}
		s.SetValue(nil)
	})
	return f
}
