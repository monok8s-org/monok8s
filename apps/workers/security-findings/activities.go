package securityfindings

import (
	"context"
	"fmt"
	"strings"
	"time"

	"go.temporal.io/sdk/activity"
)

// ResolveTenantFromResourceActivity extracts the tenant ID from the cloud
// resource tags embedded in the finding. Falls back to looking up the
// resource ARN/name in the database if tags are absent.
func ResolveTenantFromResourceActivity(ctx context.Context, finding NormalisedFinding) (string, error) {
	// ResourceID is set by the consumer if the cloud payload included the
	// monok8s.io/resource-id tag. If so, verify it exists in our DB.
	if finding.ResourceID != "" {
		db := dbFromContext(ctx)
		rows, err := db.QueryStrings(
			`SELECT id FROM tenants WHERE id = $1 AND status = 'active'`,
			finding.ResourceID,
		)
		if err == nil && len(rows) > 0 {
			return rows[0], nil
		}
	}

	// Fall back: look up by resource ARN/name in the resource inventory table.
	if finding.ResourceARN != "" {
		db := dbFromContext(ctx)
		rows, err := db.QueryStrings(
			`SELECT tenant_id FROM cloud_resources WHERE resource_arn = $1`,
			finding.ResourceARN,
		)
		if err == nil && len(rows) > 0 {
			return rows[0], nil
		}
	}

	return "", fmt.Errorf("cannot resolve tenant for resource %q (ARN: %q)", finding.ResourceID, finding.ResourceARN)
}

// ForwardFindingToAlertmanagerActivity POSTs the finding as an Alertmanager
// alert with tenant_id and source labels injected. The existing Alertmanager
// routing rules already handle per-tenant notification dispatch.
func ForwardFindingToAlertmanagerActivity(ctx context.Context, finding NormalisedFinding) error {
	logger := activity.GetLogger(ctx)
	logger.Info("forwarding security finding to alertmanager",
		"finding_id", finding.FindingID,
		"tenant_id", finding.TenantID,
		"severity", finding.Severity,
		"cloud", finding.Cloud,
	)

	alertmanager := alertmanagerFromContext(ctx)

	// Build an Alertmanager-compatible alert payload.
	// Labels match the Alertmanager routing rules used for Model B alerts.
	alert := AlertmanagerAlert{
		Labels: map[string]string{
			"alertname":    "SecurityFinding",
			"severity":     finding.Severity,
			"tenant_id":    finding.TenantID,
			"cloud":        finding.Cloud,
			"source":       "security_findings",
			"finding_type": finding.FindingType,
			"resource_type": finding.ResourceType,
		},
		Annotations: map[string]string{
			"summary":     finding.Title,
			"description": finding.Description,
			"finding_id":  finding.FindingID,
			"resource":    finding.ResourceARN,
			"cloud_link":  cloudConsoleLink(finding),
		},
		StartsAt: finding.ReceivedAt,
		// No EndsAt — Alertmanager will auto-resolve after resolve_timeout (5m default)
		// unless we send a resolved update. The security-findings worker re-processes
		// resolved events from the cloud and calls this activity with status="resolved",
		// which sends EndsAt = time.Now().
	}
	if finding.Status == "resolved" || finding.Status == "suppressed" {
		alert.EndsAt = time.Now()
	}

	return alertmanager.PostAlerts(ctx, []AlertmanagerAlert{alert})
}

// WriteSecurityFindingAuditActivity persists the finding to the ops dashboard table.
func WriteSecurityFindingAuditActivity(ctx context.Context, finding NormalisedFinding) error {
	db := dbFromContext(ctx)
	return db.Exec(`
		INSERT INTO security_finding_incidents
			(finding_id, cloud, tenant_id, resource_type, resource_id, resource_arn,
			 severity, title, description, finding_type, status, raw_payload, received_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
		ON CONFLICT (finding_id) DO UPDATE SET
			status       = EXCLUDED.status,
			raw_payload  = EXCLUDED.raw_payload,
			updated_at   = NOW()
	`,
		finding.FindingID, finding.Cloud, finding.TenantID,
		finding.ResourceType, finding.ResourceID, finding.ResourceARN,
		finding.Severity, finding.Title, finding.Description,
		finding.FindingType, finding.Status, finding.RawPayload,
		finding.ReceivedAt,
	)
}

// WriteOrphanedFindingActivity persists findings where the resource has no tenant.
// These appear in the platform admin dashboard under "unresolved findings".
func WriteOrphanedFindingActivity(ctx context.Context, finding NormalisedFinding) error {
	db := dbFromContext(ctx)
	return db.Exec(`
		INSERT INTO security_finding_incidents
			(finding_id, cloud, tenant_id, resource_type, resource_id, resource_arn,
			 severity, title, description, finding_type, status, raw_payload, received_at, created_at)
		VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
		ON CONFLICT (finding_id) DO NOTHING
	`,
		finding.FindingID, finding.Cloud,
		finding.ResourceType, finding.ResourceID, finding.ResourceARN,
		finding.Severity, finding.Title, finding.Description,
		finding.FindingType, "orphaned", finding.RawPayload, finding.ReceivedAt,
	)
}

// ── Cloud console deep links ───────────────────────────────────────────────────

func cloudConsoleLink(f NormalisedFinding) string {
	switch f.Cloud {
	case "aws":
		// Link to Security Hub finding
		region := extractAWSRegion(f.ResourceARN)
		return fmt.Sprintf("https://console.aws.amazon.com/securityhub/home?region=%s#/findings?search=Id%%3D%s",
			region, f.FindingID)
	case "azure":
		// Link to Defender for Cloud alert
		return fmt.Sprintf("https://portal.azure.com/#blade/Microsoft_Azure_Security/SecurityMenuBlade/alerts/alertId/%s",
			f.FindingID)
	case "gcp":
		// Link to SCC finding
		return fmt.Sprintf("https://console.cloud.google.com/security/command-center/findings?findingId=%s",
			f.FindingID)
	}
	return ""
}

func extractAWSRegion(arn string) string {
	// arn:aws:service:region:account:resource
	parts := strings.SplitN(arn, ":", 5)
	if len(parts) >= 4 {
		return parts[3]
	}
	return "us-east-1"
}

// ── Types ──────────────────────────────────────────────────────────────────────

type AlertmanagerAlert struct {
	Labels      map[string]string
	Annotations map[string]string
	StartsAt    time.Time
	EndsAt      time.Time `json:",omitempty"`
}

// ── Context helpers and stub interfaces ───────────────────────────────────────

type dbKey struct{}
type alertmanagerKey struct{}

type dbIface interface {
	Exec(query string, args ...any) error
	QueryStrings(query string, args ...any) ([]string, error)
}

type alertmanagerIface interface {
	PostAlerts(ctx context.Context, alerts []AlertmanagerAlert) error
}

func dbFromContext(ctx context.Context) dbIface {
	return ctx.Value(dbKey{}).(dbIface)
}

func alertmanagerFromContext(ctx context.Context) alertmanagerIface {
	return ctx.Value(alertmanagerKey{}).(alertmanagerIface)
}
