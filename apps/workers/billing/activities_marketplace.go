package billing

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
)

// Marketplace metering activities
//
// Each cloud marketplace requires periodic usage record submission so customers
// are billed correctly. Metering must happen even if the customer's cluster is
// down — it is decoupled from the heartbeat/telemetry path.
//
// All three clouds use a "dimension" model where we report a named quantity
// (e.g. "active_users", "tenant_count") per billing period. The dimensions
// are defined in each marketplace listing configuration.
//
// Failure handling: metering records are written to the `marketplace_usage_records`
// table before submission. If the cloud API call fails, the record stays in
// "pending" state and the metering workflow retries with exponential backoff.
// Cloud marketplaces accept duplicate records idempotently (via idempotency key),
// so retries are safe.

// MarketplaceUsageRecord is the normalised metering payload.
type MarketplaceUsageRecord struct {
	TenantID         string
	Source           string // "aws_marketplace" | "gcp_marketplace" | "azure_marketplace"
	PeriodStartUTC   time.Time
	PeriodEndUTC     time.Time
	DimensionName    string // matches the listing's configured dimension name
	Quantity         int64
	IdempotencyKey   string // set to "<tenant_id>:<period_start_unix>" to allow safe retries
	ExternalRecordID string // set after successful submission; used for audit
}

// ── AWS ───────────────────────────────────────────────────────────────────────

// SubmitAWSMeteringRecordActivity submits a usage record to the AWS Marketplace
// Metering Service. The activity is idempotent — AWS deduplicates on UsageRecordId.
func SubmitAWSMeteringRecordActivity(ctx context.Context, record MarketplaceUsageRecord) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("submitting AWS marketplace metering record",
		"tenant_id", record.TenantID,
		"dimension", record.DimensionName,
		"quantity", record.Quantity,
		"period_start", record.PeriodStartUTC,
	)

	// Build the BatchMeterUsage request. AWS accepts up to 25 records per call
	// but we submit one per tenant per period for simplicity.
	// aws-sdk-go-v2 is used here; the SDK client is injected via activity context.
	db := dbFromContext(ctx)
	cfg := awsConfigFromContext(ctx)

	meteringClient := newAWSMeteringClient(cfg)
	result, err := meteringClient.BatchMeterUsage(ctx, &awsMeteringInput{
		ProductCode: awsProductCode(ctx),
		UsageRecords: []awsUsageRecord{
			{
				CustomerIdentifier: record.TenantID,           // stored at subscribe time
				Dimension:          record.DimensionName,
				Quantity:           int32(record.Quantity),
				Timestamp:          record.PeriodEndUTC,
				UsageRecordId:      record.IdempotencyKey,      // idempotency key
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("AWS BatchMeterUsage: %w", err)
	}
	if len(result.UnprocessedRecords) > 0 {
		return "", fmt.Errorf("AWS BatchMeterUsage: %d unprocessed records: %v",
			len(result.UnprocessedRecords), result.UnprocessedRecords[0].MeteringRecordId)
	}

	externalID := result.Results[0].MeteringRecordId
	if err := db.Exec(`
		UPDATE marketplace_usage_records
		SET status = 'submitted', external_record_id = $1, submitted_at = NOW()
		WHERE idempotency_key = $2
	`, externalID, record.IdempotencyKey); err != nil {
		// Non-fatal — metering was submitted successfully; DB update failure is ignorable.
		logger.Warn("failed to mark metering record as submitted", "err", err)
	}
	return externalID, nil
}

// ── GCP ───────────────────────────────────────────────────────────────────────

// SubmitGCPMeteringRecordActivity submits a usage record to the GCP Cloud
// Commerce Service Provider API (servicecontrol.googleapis.com).
func SubmitGCPMeteringRecordActivity(ctx context.Context, record MarketplaceUsageRecord) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("submitting GCP marketplace metering record",
		"tenant_id", record.TenantID,
		"dimension", record.DimensionName,
		"quantity", record.Quantity,
	)

	// GCP uses the Service Control API v1 report() method.
	// Service name comes from the marketplace listing (e.g. "monok8s.endpoints.PROJECT.cloud.goog")
	db := dbFromContext(ctx)
	svcName := gcpServiceNameFromContext(ctx)
	client := gcpServiceControlClientFromContext(ctx)

	operationID := record.IdempotencyKey // reuse as GCP operation ID for deduplication

	err := client.Report(ctx, &gcpReportRequest{
		ServiceName: svcName,
		Operations: []gcpOperation{
			{
				OperationId:   operationID,
				ConsumerId:    "project:" + record.TenantID,
				StartTime:     record.PeriodStartUTC,
				EndTime:       record.PeriodEndUTC,
				MetricValueSets: []gcpMetricValueSet{
					{
						MetricName: svcName + "/" + record.DimensionName,
						MetricValues: []gcpMetricValue{
							{Int64Value: record.Quantity},
						},
					},
				},
			},
		},
	})
	if err != nil {
		return "", fmt.Errorf("GCP ServiceControl Report: %w", err)
	}

	if err := db.Exec(`
		UPDATE marketplace_usage_records
		SET status = 'submitted', external_record_id = $1, submitted_at = NOW()
		WHERE idempotency_key = $2
	`, operationID, record.IdempotencyKey); err != nil {
		logger.Warn("failed to mark GCP metering record as submitted", "err", err)
	}
	return operationID, nil
}

// ── Azure ─────────────────────────────────────────────────────────────────────

// SubmitAzureMeteringRecordActivity submits a usage record to the Azure Marketplace
// Metering Service API (marketplaceapi.azure.com).
func SubmitAzureMeteringRecordActivity(ctx context.Context, record MarketplaceUsageRecord) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("submitting Azure marketplace metering record",
		"tenant_id", record.TenantID,
		"dimension", record.DimensionName,
		"quantity", record.Quantity,
	)

	db := dbFromContext(ctx)
	client := azureMeteringClientFromContext(ctx)

	// Azure Metering API expects the SaaS subscription ID (stored at subscribe time),
	// the plan ID, and dimension name from the listing.
	sub := azureSaaSSubscriptionFromContext(ctx, record.TenantID)
	result, err := client.PostUsageEvent(ctx, &azureUsageEvent{
		ResourceID:     sub.SubscriptionID,
		Quantity:       float64(record.Quantity),
		Dimension:      record.DimensionName,
		EffectiveStart: record.PeriodEndUTC.Format(time.RFC3339),
		PlanID:         sub.PlanID,
	})
	if err != nil {
		return "", fmt.Errorf("Azure metering PostUsageEvent: %w", err)
	}

	if err := db.Exec(`
		UPDATE marketplace_usage_records
		SET status = 'submitted', external_record_id = $1, submitted_at = NOW()
		WHERE idempotency_key = $2
	`, result.UsageEventID, record.IdempotencyKey); err != nil {
		logger.Warn("failed to mark Azure metering record as submitted", "err", err)
	}
	return result.UsageEventID, nil
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

// CollectMeteringDataActivity reads current usage metrics (active users, tenant
// count, etc.) from the database and writes pending marketplace_usage_records
// rows for each marketplace-sourced tenant. Called at the top of each metering
// workflow execution before submission activities run.
func CollectMeteringDataActivity(ctx context.Context, periodEnd time.Time) ([]MarketplaceUsageRecord, error) {
	db := dbFromContext(ctx)

	rows, err := db.Query(`
		SELECT
			t.id                          AS tenant_id,
			t.marketplace_source          AS source,
			t.marketplace_customer_id     AS customer_id,
			t.marketplace_plan            AS plan,
			COUNT(DISTINCT tm.user_id)    AS active_user_count,
			$1::timestamptz - INTERVAL '1 hour' AS period_start,
			$1::timestamptz               AS period_end
		FROM tenants t
		JOIN tenant_memberships tm ON tm.tenant_id = t.id
		WHERE t.marketplace_source IS NOT NULL
		  AND t.status = 'active'
		GROUP BY t.id
	`, periodEnd)
	if err != nil {
		return nil, fmt.Errorf("collecting metering data: %w", err)
	}
	defer rows.Close()

	var records []MarketplaceUsageRecord
	for rows.Next() {
		var r MarketplaceUsageRecord
		var periodStart time.Time
		var customerID, plan string
		if err := rows.Scan(
			&r.TenantID, &r.Source, &customerID, &plan,
			&r.Quantity, &periodStart, &r.PeriodEndUTC,
		); err != nil {
			return nil, err
		}
		r.PeriodStartUTC = periodStart
		r.DimensionName  = "active_users" // matches all three listing configurations
		r.IdempotencyKey = fmt.Sprintf("%s:%d", r.TenantID, periodEnd.Unix())

		// Write a pending record so we can track submission status
		if err := db.Exec(`
			INSERT INTO marketplace_usage_records
				(tenant_id, source, dimension_name, quantity, period_start, period_end,
				 idempotency_key, status, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
			ON CONFLICT (idempotency_key) DO NOTHING
		`, r.TenantID, r.Source, r.DimensionName, r.Quantity,
			r.PeriodStartUTC, r.PeriodEndUTC, r.IdempotencyKey); err != nil {
			return nil, fmt.Errorf("inserting metering record for %s: %w", r.TenantID, err)
		}
		records = append(records, r)
	}
	return records, rows.Err()
}

// ApproveGCPEntitlementActivity calls the Cloud Commerce Producer API to approve
// a pending entitlement creation request. Must be called within 15 minutes of
// receiving the ENTITLEMENT_CREATION_REQUESTED webhook.
func ApproveGCPEntitlementActivity(ctx context.Context, entitlementID string) error {
	client := gcpCommerceClientFromContext(ctx)
	return client.ApproveEntitlement(ctx, entitlementID)
}

// ConfirmAzureOperationActivity calls the Azure Marketplace SaaS Fulfillment
// Operations API to mark an operation (subscribe/unsubscribe/plan change) as
// succeeded or failed. Azure retries the webhook if we don't confirm within 10s,
// but we confirm asynchronously from the workflow to keep the webhook handler fast.
func ConfirmAzureOperationActivity(ctx context.Context, subscriptionID, operationID, status string) error {
	// status: "Success" or "Failure"
	client := azureFulfillmentClientFromContext(ctx)
	return client.ConfirmOperation(ctx, subscriptionID, operationID, status)
}

// ── Stub types (replaced by real SDK types at implementation time) ─────────────
// These prevent compilation errors while keeping the file self-contained.

type awsMeteringInput struct {
	ProductCode  string
	UsageRecords []awsUsageRecord
}
type awsUsageRecord struct {
	CustomerIdentifier string
	Dimension          string
	Quantity           int32
	Timestamp          time.Time
	UsageRecordId      string
}
type awsMeteringResult struct {
	Results            []struct{ MeteringRecordId string }
	UnprocessedRecords []struct{ MeteringRecordId string }
}
type gcpReportRequest struct {
	ServiceName string
	Operations  []gcpOperation
}
type gcpOperation struct {
	OperationId     string
	ConsumerId      string
	StartTime       time.Time
	EndTime         time.Time
	MetricValueSets []gcpMetricValueSet
}
type gcpMetricValueSet struct {
	MetricName   string
	MetricValues []gcpMetricValue
}
type gcpMetricValue struct{ Int64Value int64 }
type azureUsageEvent struct {
	ResourceID     string
	Quantity       float64
	Dimension      string
	EffectiveStart string
	PlanID         string
}
type azureUsageResult struct{ UsageEventID string }
type azureSaaSSubscription struct {
	SubscriptionID string
	PlanID         string
}

// Context accessors — injected by worker startup via activity.WithValue.
func dbFromContext(ctx context.Context) dbClient                          { return ctx.Value(dbKey{}).(dbClient) }
func awsConfigFromContext(ctx context.Context) awsConfig                  { return ctx.Value(awsConfigKey{}).(awsConfig) }
func gcpServiceNameFromContext(ctx context.Context) string                 { return ctx.Value(gcpSvcNameKey{}).(string) }
func gcpServiceControlClientFromContext(ctx context.Context) gcpSvcCtlClient { return ctx.Value(gcpSvcCtlKey{}).(gcpSvcCtlClient) }
func gcpCommerceClientFromContext(ctx context.Context) gcpCommerceClient  { return ctx.Value(gcpCommerceKey{}).(gcpCommerceClient) }
func azureMeteringClientFromContext(ctx context.Context) azureMeteringClient { return ctx.Value(azureMeteringKey{}).(azureMeteringClient) }
func azureFulfillmentClientFromContext(ctx context.Context) azureFulfillClient { return ctx.Value(azureFulfillKey{}).(azureFulfillClient) }
func azureSaaSSubscriptionFromContext(ctx context.Context, tenantID string) azureSaaSSubscription {
	return ctx.Value(azureSubKey{}).(func(string) azureSaaSSubscription)(tenantID)
}
func newAWSMeteringClient(_ awsConfig) awsMeteringClientIface { return nil }
func awsProductCode(ctx context.Context) string               { return ctx.Value(awsProductKey{}).(string) }

type (
	dbKey struct{}; awsConfigKey struct{}; gcpSvcNameKey struct{}
	gcpSvcCtlKey struct{}; gcpCommerceKey struct{}; azureMeteringKey struct{}
	azureFulfillKey struct{}; azureSubKey struct{}; awsProductKey struct{}
	dbClient interface {
		Exec(query string, args ...any) error
		Query(query string, args ...any) (rowsScanner, error)
	}
	rowsScanner interface {
		Next() bool
		Scan(dest ...any) error
		Close() error
		Err() error
	}
	awsConfig              interface{}
	awsMeteringClientIface interface {
		BatchMeterUsage(ctx context.Context, in *awsMeteringInput) (*awsMeteringResult, error)
	}
	gcpSvcCtlClient interface {
		Report(ctx context.Context, req *gcpReportRequest) error
	}
	gcpCommerceClient interface {
		ApproveEntitlement(ctx context.Context, id string) error
	}
	azureMeteringClient interface {
		PostUsageEvent(ctx context.Context, ev *azureUsageEvent) (*azureUsageResult, error)
	}
	azureFulfillClient interface {
		ConfirmOperation(ctx context.Context, subID, opID, status string) error
	}
)
