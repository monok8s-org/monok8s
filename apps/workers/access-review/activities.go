package accessreview

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
)

// ── Internal access review activities ─────────────────────────────────────────

// GetTenantsWithStaleAssignmentsActivity returns tenant IDs that have at least
// one role assignment older than windowDays without a recent access review.
func GetTenantsWithStaleAssignmentsActivity(ctx context.Context, windowDays int) ([]string, error) {
	db := dbFromContext(ctx)
	rows, err := db.Query(`
		SELECT DISTINCT tenant_id
		FROM tenant_memberships
		WHERE created_at < NOW() - ($1 || ' days')::interval
		  AND (last_reviewed_at IS NULL
		       OR last_reviewed_at < NOW() - ($1 || ' days')::interval)
		  AND status = 'active'
	`, windowDays)
	if err != nil {
		return nil, fmt.Errorf("fetching tenants for access review: %w", err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// GetStaleAssignmentsActivity returns all assignments for a tenant that are
// older than windowDays and have not been reviewed recently.
func GetStaleAssignmentsActivity(ctx context.Context, tenantID string, windowDays int) ([]AssignmentForReview, error) {
	db := dbFromContext(ctx)
	rows, err := db.Query(`
		SELECT id, tenant_id, user_id, role, created_at, last_reviewed_at
		FROM tenant_memberships
		WHERE tenant_id = $1
		  AND created_at < NOW() - ($2 || ' days')::interval
		  AND (last_reviewed_at IS NULL
		       OR last_reviewed_at < NOW() - ($2 || ' days')::interval)
		  AND status = 'active'
		ORDER BY created_at ASC
	`, tenantID, windowDays)
	if err != nil {
		return nil, fmt.Errorf("fetching stale assignments for tenant %s: %w", tenantID, err)
	}
	defer rows.Close()
	var assignments []AssignmentForReview
	for rows.Next() {
		var a AssignmentForReview
		if err := rows.Scan(&a.AssignmentID, &a.TenantID, &a.UserID, &a.Role,
			&a.AssignedAt, &a.LastReviewAt); err != nil {
			return nil, err
		}
		assignments = append(assignments, a)
	}
	return assignments, rows.Err()
}

// SendReviewNotificationActivity sends an email to tenant owner(s) listing
// assignments that need recertification and returns the review ID.
func SendReviewNotificationActivity(ctx context.Context, input ReviewNotificationInput) (string, error) {
	logger := activity.GetLogger(ctx)
	logger.Info("sending access review notification",
		"tenant_id", input.TenantID,
		"assignment_count", len(input.Assignments),
		"deadline", input.DeadlineUTC,
	)
	mailer := mailerFromContext(ctx)
	db := dbFromContext(ctx)

	// Find owner emails for this tenant.
	ownerEmails, err := db.QueryStrings(`
		SELECT u.email
		FROM tenant_memberships tm
		JOIN users u ON u.id = tm.user_id
		WHERE tm.tenant_id = $1 AND tm.role = 'owner' AND tm.status = 'active'
	`, input.TenantID)
	if err != nil {
		return "", fmt.Errorf("fetching owner emails: %w", err)
	}
	if len(ownerEmails) == 0 {
		logger.Warn("no owners found for access review — skipping notification", "tenant_id", input.TenantID)
		return input.ReviewID, nil
	}

	reviewURL := fmt.Sprintf("https://app.monok8s.io/settings/access-review?id=%s", input.ReviewID)
	if err := mailer.Send(ctx, EmailMessage{
		To:      ownerEmails,
		Subject: fmt.Sprintf("[monok8s] Access review required — %d assignments need recertification", len(input.Assignments)),
		TemplateID: "access-review-notification",
		TemplateVars: map[string]any{
			"assignment_count": len(input.Assignments),
			"deadline":         input.DeadlineUTC.Format("January 2, 2006"),
			"review_url":       reviewURL,
		},
	}); err != nil {
		return "", fmt.Errorf("sending review notification: %w", err)
	}
	return input.ReviewID, nil
}

// SendReminderNotificationActivity sends a reminder for pending assignments.
func SendReminderNotificationActivity(ctx context.Context, input ReviewNotificationInput) error {
	activity.GetLogger(ctx).Info("sending access review reminder",
		"tenant_id", input.TenantID,
		"pending_count", len(input.Assignments),
	)
	mailer := mailerFromContext(ctx)
	db := dbFromContext(ctx)

	ownerEmails, err := db.QueryStrings(`
		SELECT u.email
		FROM tenant_memberships tm
		JOIN users u ON u.id = tm.user_id
		WHERE tm.tenant_id = $1 AND tm.role = 'owner' AND tm.status = 'active'
	`, input.TenantID)
	if err != nil {
		return err
	}
	reviewURL := fmt.Sprintf("https://app.monok8s.io/settings/access-review?id=%s", input.ReviewID)
	return mailer.Send(ctx, EmailMessage{
		To:      ownerEmails,
		Subject: fmt.Sprintf("[monok8s] Reminder: %d access review decisions pending", len(input.Assignments)),
		TemplateID: "access-review-reminder",
		TemplateVars: map[string]any{
			"pending_count": len(input.Assignments),
			"deadline":      input.DeadlineUTC.Format("January 2, 2006"),
			"review_url":    reviewURL,
		},
	})
}

// RevokeAssignmentActivity removes a role assignment from SpiceDB and writes
// a revocation event to the membership audit log.
func RevokeAssignmentActivity(ctx context.Context, input RevokeAssignmentInput) error {
	logger := activity.GetLogger(ctx)
	logger.Info("revoking assignment after access review",
		"tenant_id", input.TenantID,
		"user_id", input.UserID,
		"role", input.Role,
		"reason", input.Reason,
	)
	spicedb := spiceDBFromContext(ctx)
	db := dbFromContext(ctx)

	// Remove from SpiceDB — Crossplane will reconcile the cloud projection.
	if err := spicedb.DeleteRelationship(ctx, SpiceDBRelationship{
		ResourceType: "tenant",
		ResourceID:   input.TenantID,
		Relation:     input.Role,
		SubjectType:  "user",
		SubjectID:    input.UserID,
	}); err != nil {
		return fmt.Errorf("SpiceDB delete relationship: %w", err)
	}

	// Mark the membership record as revoked.
	if err := db.Exec(`
		UPDATE tenant_memberships
		SET status = 'revoked', revoked_at = NOW(), revoke_reason = $3
		WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
	`, input.TenantID, input.UserID, input.Reason); err != nil {
		return fmt.Errorf("updating membership record: %w", err)
	}

	// Audit event.
	return db.Exec(`
		INSERT INTO tenant_membership_events
			(tenant_id, user_id, event_type, role, reason, created_at)
		VALUES ($1, $2, 'revoked', $3, $4, NOW())
	`, input.TenantID, input.UserID, input.Role, input.Reason)
}

// WriteAccessReviewAuditActivity appends an access review decision to the audit log.
func WriteAccessReviewAuditActivity(ctx context.Context, entry AccessReviewAuditEntry) error {
	db := dbFromContext(ctx)
	return db.Exec(`
		INSERT INTO access_review_decisions
			(review_id, tenant_id, assignment_id, user_id, role, decision, reviewed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (review_id, assignment_id) DO UPDATE
		  SET decision = EXCLUDED.decision, reviewed_at = EXCLUDED.reviewed_at
	`, entry.ReviewID, entry.TenantID, entry.AssignmentID,
		entry.UserID, entry.Role, entry.Decision, entry.ReviewedAt)
}

// ── Cloud-native access review activities ─────────────────────────────────────

// FetchAWSAccessAnalyzerFindingsActivity retrieves active findings from AWS IAM
// Access Analyzer scoped to the monok8s tag set.
func FetchAWSAccessAnalyzerFindingsActivity(ctx context.Context) ([]CloudAccessFinding, error) {
	client := awsAccessAnalyzerFromContext(ctx)

	raw, err := client.ListFindings(ctx, &awsAnalyzerListFindingsInput{
		AnalyzerArn: awsAnalyzerARNFromContext(ctx),
		Filter: map[string]awsAnalyzerFindingFilter{
			"resourceTags": {
				Contains: []string{"monok8s.io/managed:true"},
			},
			"status": {
				Eq: []string{"ACTIVE"},
			},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("AWS Access Analyzer ListFindings: %w", err)
	}

	findings := make([]CloudAccessFinding, 0, len(raw.Findings))
	for _, f := range raw.Findings {
		findings = append(findings, CloudAccessFinding{
			FindingID:    f.ID,
			Cloud:        "aws",
			ResourceType: f.ResourceType,
			ResourceID:   f.Resource,
			PrincipalID:  f.Principal["AWS"],
			FindingType:  mapAWSFindingType(f.FindingType),
			Severity:     "medium",
			RawFinding:   f.RawJSON,
		})
	}
	return findings, nil
}

// FetchAzureAccessReviewResultsActivity fetches completed access review results
// from Microsoft Graph API (Entra ID Access Reviews).
func FetchAzureAccessReviewResultsActivity(ctx context.Context) ([]CloudAccessFinding, error) {
	client := azureGraphClientFromContext(ctx)

	// List access review instances that have completed since the last run.
	instances, err := client.ListAccessReviewInstances(ctx, "monok8s-quarterly-review")
	if err != nil {
		return nil, fmt.Errorf("Azure access review list instances: %w", err)
	}

	var findings []CloudAccessFinding
	for _, instance := range instances {
		if instance.Status != "completed" {
			continue
		}
		decisions, err := client.ListAccessReviewDecisions(ctx, instance.ReviewID, instance.InstanceID)
		if err != nil {
			return nil, err
		}
		for _, d := range decisions {
			if d.Decision == "Deny" || d.Decision == "DontKnow" {
				findings = append(findings, CloudAccessFinding{
					FindingID:    fmt.Sprintf("az-review-%s-%s", instance.InstanceID, d.PrincipalID),
					Cloud:        "azure",
					ResourceType: "entra_group_membership",
					ResourceID:   d.ResourceID,
					PrincipalID:  d.PrincipalID,
					FindingType:  "access_review_deny",
					Severity:     "low",
					RawFinding:   d.RawJSON,
				})
			}
		}
	}
	return findings, nil
}

// FetchGCPIAMRecommendationsActivity fetches IAM Recommender suggestions for
// roles that can be replaced with a more restricted role.
func FetchGCPIAMRecommendationsActivity(ctx context.Context) ([]CloudAccessFinding, error) {
	client := gcpRecommenderFromContext(ctx)
	project := gcpProjectFromContext(ctx)

	recs, err := client.ListRecommendations(ctx, &gcpRecommendationsRequest{
		Parent:          fmt.Sprintf("projects/%s/locations/global/recommenders/google.iam.policy.Recommender", project),
		Filter:          "stateInfo.state = ACTIVE",
	})
	if err != nil {
		return nil, fmt.Errorf("GCP IAM Recommender: %w", err)
	}

	var findings []CloudAccessFinding
	for _, r := range recs {
		// Only surface recommendations about monok8s-managed roles.
		if !isMonok8sRole(r.RoleName) {
			continue
		}
		findings = append(findings, CloudAccessFinding{
			FindingID:    r.Name,
			Cloud:        "gcp",
			ResourceType: r.ResourceType,
			ResourceID:   r.ResourceName,
			PrincipalID:  r.Member,
			FindingType:  "excessive_permission",
			Severity:     "low",
			RawFinding:   r.RawJSON,
		})
	}
	return findings, nil
}

// ReconcileCloudFindingActivity checks a cloud access finding against SpiceDB
// and revokes the assignment if it should not exist.
func ReconcileCloudFindingActivity(ctx context.Context, finding CloudAccessFinding) error {
	logger := activity.GetLogger(ctx)

	// Only act on deny decisions and denied external access — recommendations
	// are informational and are surfaced in the ops dashboard rather than auto-revoked.
	if finding.FindingType != "external_access" && finding.FindingType != "access_review_deny" {
		logger.Info("cloud finding is informational — skipping auto-revocation",
			"finding_id", finding.FindingID, "type", finding.FindingType)
		return nil
	}

	spicedb := spiceDBFromContext(ctx)
	// Look up whether the principal has a corresponding SpiceDB relationship.
	// If not, the assignment is orphaned and should be cleaned up.
	exists, err := spicedb.CheckRelationshipExists(ctx, finding.ResourceType, finding.ResourceID, finding.PrincipalID)
	if err != nil {
		return fmt.Errorf("SpiceDB check for finding %s: %w", finding.FindingID, err)
	}
	if !exists {
		logger.Info("cloud finding references principal not in SpiceDB — flagging for review",
			"finding_id", finding.FindingID, "principal", finding.PrincipalID)
		// The write-back revert handles removal from the cloud side.
		// Here we just log the incident.
		db := dbFromContext(ctx)
		return db.Exec(`
			INSERT INTO security_finding_incidents
				(finding_id, cloud, resource_type, resource_id, principal_id,
				 finding_type, severity, raw_finding, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
			ON CONFLICT (finding_id) DO NOTHING
		`, finding.FindingID, finding.Cloud, finding.ResourceType, finding.ResourceID,
			finding.PrincipalID, finding.FindingType, finding.Severity, finding.RawFinding)
	}
	return nil
}

// ── Stub types and context helpers ────────────────────────────────────────────

type EmailMessage struct {
	To           []string
	Subject      string
	TemplateID   string
	TemplateVars map[string]any
}

type SpiceDBRelationship struct {
	ResourceType string
	ResourceID   string
	Relation     string
	SubjectType  string
	SubjectID    string
}

func isMonok8sRole(role string) bool {
	return len(role) > 8 && role[:8] == "monok8s_"
}

func mapAWSFindingType(t string) string {
	switch t {
	case "ExternalAccess":
		return "external_access"
	case "UnusedPermission", "UnusedIAMRole", "UnusedIAMUserPassword", "UnusedIAMUserAccessKey":
		return "unused_permission"
	default:
		return "excessive_permission"
	}
}

// ── AWS IAM Access Analyzer stub types ────────────────────────────────────────
type awsAnalyzerListFindingsInput struct {
	AnalyzerArn string
	Filter      map[string]awsAnalyzerFindingFilter
}
type awsAnalyzerFindingFilter struct {
	Contains []string
	Eq       []string
}
type awsAnalyzerFinding struct {
	ID          string
	ResourceType string
	Resource    string
	Principal   map[string]string
	FindingType string
	RawJSON     string
}
type awsAnalyzerListFindingsOutput struct {
	Findings []awsAnalyzerFinding
}

// ── Azure Graph stub types ─────────────────────────────────────────────────────
type azureAccessReviewInstance struct {
	ReviewID   string
	InstanceID string
	Status     string
}
type azureAccessReviewDecision struct {
	PrincipalID string
	ResourceID  string
	Decision    string
	RawJSON     string
}

// ── GCP Recommender stub types ─────────────────────────────────────────────────
type gcpRecommendationsRequest struct {
	Parent string
	Filter string
}
type gcpRecommendation struct {
	Name         string
	ResourceType string
	ResourceName string
	RoleName     string
	Member       string
	RawJSON      string
}
type gcpRecommendationsResponse struct {
	Recommendations []gcpRecommendation
}

// ── Context accessors ──────────────────────────────────────────────────────────
type (
	dbKey2 struct{}; mailerKey struct{}; spicedbKey struct{}
	awsAnalyzerKey struct{}; awsAnalyzerARNKey struct{}
	azureGraphKey struct{}; gcpRecommenderKey struct{}; gcpProjectKey struct{}
)

type dbIface interface {
	Exec(query string, args ...any) error
	Query(query string, args ...any) (rowsIface, error)
	QueryStrings(query string, args ...any) ([]string, error)
}
type rowsIface interface {
	Next() bool
	Scan(dest ...any) error
	Close() error
	Err() error
}
type mailerIface interface {
	Send(ctx context.Context, msg EmailMessage) error
}
type spicedbIface interface {
	DeleteRelationship(ctx context.Context, rel SpiceDBRelationship) error
	CheckRelationshipExists(ctx context.Context, resourceType, resourceID, principalID string) (bool, error)
}
type azureGraphClientIface interface {
	ListAccessReviewInstances(ctx context.Context, reviewDefID string) ([]azureAccessReviewInstance, error)
	ListAccessReviewDecisions(ctx context.Context, reviewID, instanceID string) ([]azureAccessReviewDecision, error)
}
type awsAccessAnalyzerIface interface {
	ListFindings(ctx context.Context, input *awsAnalyzerListFindingsInput) (*awsAnalyzerListFindingsOutput, error)
}
type gcpRecommenderIface interface {
	ListRecommendations(ctx context.Context, req *gcpRecommendationsRequest) (*gcpRecommendationsResponse, error)
}

func dbFromContext(ctx context.Context) dbIface { return ctx.Value(dbKey2{}).(dbIface) }
func mailerFromContext(ctx context.Context) mailerIface { return ctx.Value(mailerKey{}).(mailerIface) }
func spiceDBFromContext(ctx context.Context) spicedbIface { return ctx.Value(spicedbKey{}).(spicedbIface) }
func awsAccessAnalyzerFromContext(ctx context.Context) awsAccessAnalyzerIface {
	return ctx.Value(awsAnalyzerKey{}).(awsAccessAnalyzerIface)
}
func awsAnalyzerARNFromContext(ctx context.Context) string {
	return ctx.Value(awsAnalyzerARNKey{}).(string)
}
func azureGraphClientFromContext(ctx context.Context) azureGraphClientIface {
	return ctx.Value(azureGraphKey{}).(azureGraphClientIface)
}
func gcpRecommenderFromContext(ctx context.Context) gcpRecommenderIface {
	return ctx.Value(gcpRecommenderKey{}).(gcpRecommenderIface)
}
func gcpProjectFromContext(ctx context.Context) string {
	return ctx.Value(gcpProjectKey{}).(string)
}

// Suppress unused import warning for time package usage in ReviewNotificationInput
var _ = time.Now
