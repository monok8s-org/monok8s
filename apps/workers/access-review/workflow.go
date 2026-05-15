package accessreview

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// Access review workflows
//
// Periodic recertification of role assignments. The workflow:
//   1. Fetches all active role assignments older than the review window
//   2. Notifies the tenant owner(s) via email to confirm or revoke each assignment
//   3. Waits for responses (up to the deadline)
//   4. Auto-revokes assignments with no response (deny-by-default)
//   5. Writes the recertification outcome to the audit log
//
// This satisfies SOC 2 CC6.3 (access removal) and ISO 27001 A.9.2.5 (review of
// user access rights) requirements for customers on compliance tiers.
//
// Task queue: "access-review"
// Scheduled: quarterly (see platform/access-review/schedule.yaml)

const (
	reviewWindowDays     = 90  // assignments older than this are included in review
	responseDeadlineDays = 14  // owners have 14 days to respond
	reminderIntervalDays = 7   // send a reminder after 7 days of no response
)

// AccessReviewWorkflow runs a full access review cycle across all tenants.
// Spawns one AccessReviewTenantWorkflow child per tenant with active assignments
// due for review. Children run in parallel.
func AccessReviewWorkflow(ctx workflow.Context) error {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	var tenantIDs []string
	if err := workflow.ExecuteActivity(ctx, GetTenantsWithStaleAssignmentsActivity,
		reviewWindowDays,
	).Get(ctx, &tenantIDs); err != nil {
		return err
	}

	// Fan out — one child workflow per tenant, all in parallel.
	futures := make([]workflow.Future, 0, len(tenantIDs))
	for _, tenantID := range tenantIDs {
		childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
			WorkflowID:        "access-review-tenant-" + tenantID + "-" + workflow.Now(ctx).Format("2006-Q1"),
			ParentClosePolicy: temporal.ParentClosePolicyAbandon, // parent completing doesn't cancel children
		})
		futures = append(futures, workflow.ExecuteChildWorkflow(
			childCtx, AccessReviewTenantWorkflow, tenantID,
		))
	}

	// Wait for all children — log failures but don't abort the whole review.
	var firstErr error
	for _, f := range futures {
		if err := f.Get(ctx, nil); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// AccessReviewTenantWorkflow handles recertification for a single tenant.
// Sends notification → waits with reminders → auto-revokes non-responses.
func AccessReviewTenantWorkflow(ctx workflow.Context, tenantID string) error {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
			InitialInterval: 5 * time.Second,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Fetch all assignments due for review for this tenant.
	var assignments []AssignmentForReview
	if err := workflow.ExecuteActivity(ctx, GetStaleAssignmentsActivity,
		tenantID, reviewWindowDays,
	).Get(ctx, &assignments); err != nil {
		return err
	}
	if len(assignments) == 0 {
		return nil
	}

	// Send initial review notification to tenant owner(s).
	var reviewID string
	if err := workflow.ExecuteActivity(ctx, SendReviewNotificationActivity,
		ReviewNotificationInput{
			TenantID:    tenantID,
			Assignments: assignments,
			ReviewID:    workflow.GetInfo(ctx).WorkflowExecution.ID,
			DeadlineUTC: workflow.Now(ctx).Add(responseDeadlineDays * 24 * time.Hour),
		},
	).Get(ctx, &reviewID); err != nil {
		return err
	}

	// Listen for responses via signal "review-decision:<reviewID>"
	// while also sending reminders and enforcing the deadline.
	decisions := make(map[string]string) // assignmentID → "confirmed" | "revoked"

	decisionCh := workflow.GetSignalChannel(ctx, "review-decision")
	deadline := workflow.NewTimer(ctx, responseDeadlineDays*24*time.Hour)
	reminder := workflow.NewTimer(ctx, reminderIntervalDays*24*time.Hour)

	for len(decisions) < len(assignments) {
		workflow.Select(ctx,
			workflow.Receive(decisionCh, func(c workflow.ReceiveChannel, more bool) {
				var d ReviewDecision
				c.Receive(ctx, &d)
				if d.ReviewID == reviewID {
					decisions[d.AssignmentID] = d.Decision
				}
			}),
			workflow.Receive(reminder, func(_ workflow.ReceiveChannel, _ bool) {
				pending := pendingAssignments(assignments, decisions)
				if len(pending) == 0 {
					return
				}
				_ = workflow.ExecuteActivity(ctx, SendReminderNotificationActivity,
					ReviewNotificationInput{
						TenantID:    tenantID,
						Assignments: pending,
						ReviewID:    reviewID,
						DeadlineUTC: workflow.Now(ctx).Add(
							(responseDeadlineDays-reminderIntervalDays)*24*time.Hour,
						),
					},
				).Get(ctx, nil)
			}),
			workflow.Receive(deadline, func(_ workflow.ReceiveChannel, _ bool) {
				// Deadline reached — auto-revoke all non-responded assignments.
				for _, a := range assignments {
					if _, responded := decisions[a.AssignmentID]; !responded {
						decisions[a.AssignmentID] = "revoked" // deny-by-default
					}
				}
			}),
		)
	}

	// Apply decisions: revoke anything marked "revoked".
	for _, a := range assignments {
		decision := decisions[a.AssignmentID]
		if decision == "revoked" {
			if err := workflow.ExecuteActivity(ctx, RevokeAssignmentActivity,
				RevokeAssignmentInput{
					TenantID:     tenantID,
					UserID:       a.UserID,
					Role:         a.Role,
					AssignmentID: a.AssignmentID,
					Reason:       "access_review_revocation",
				},
			).Get(ctx, nil); err != nil {
				workflow.GetLogger(ctx).Error("failed to revoke assignment",
					"assignment_id", a.AssignmentID, "err", err)
			}
		}
		// Write audit record regardless of decision.
		_ = workflow.ExecuteActivity(ctx, WriteAccessReviewAuditActivity,
			AccessReviewAuditEntry{
				TenantID:     tenantID,
				AssignmentID: a.AssignmentID,
				UserID:       a.UserID,
				Role:         a.Role,
				Decision:     decision,
				ReviewID:     reviewID,
				ReviewedAt:   workflow.Now(ctx),
			},
		).Get(ctx, nil)
	}

	return nil
}

// CloudAccessReviewWorkflow uses each cloud's native access review / access
// analyser capabilities to surface findings and sync them back to SpiceDB.
//
// AWS:   IAM Access Analyzer — unused permissions and external access findings
// Azure: Entra ID Access Reviews — periodic review of group membership
// GCP:   IAM Recommender — unused role suggestions
//
// These complement the internal access review by catching drift between
// cloud IAM and SpiceDB that the write-back worker may have missed.
func CloudAccessReviewWorkflow(ctx workflow.Context, cloud string) error {
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
			InitialInterval: 30 * time.Second,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	var findings []CloudAccessFinding
	switch cloud {
	case "aws":
		if err := workflow.ExecuteActivity(ctx, FetchAWSAccessAnalyzerFindingsActivity).Get(ctx, &findings); err != nil {
			return err
		}
	case "azure":
		if err := workflow.ExecuteActivity(ctx, FetchAzureAccessReviewResultsActivity).Get(ctx, &findings); err != nil {
			return err
		}
	case "gcp":
		if err := workflow.ExecuteActivity(ctx, FetchGCPIAMRecommendationsActivity).Get(ctx, &findings); err != nil {
			return err
		}
	}

	// Reconcile each finding against SpiceDB.
	for _, f := range findings {
		if err := workflow.ExecuteActivity(ctx, ReconcileCloudFindingActivity, f).Get(ctx, nil); err != nil {
			workflow.GetLogger(ctx).Error("failed to reconcile cloud finding",
				"finding_id", f.FindingID, "err", err)
		}
	}
	return nil
}

// ── Types ──────────────────────────────────────────────────────────────────────

type AssignmentForReview struct {
	AssignmentID string
	TenantID     string
	UserID       string
	Role         string
	AssignedAt   time.Time
	LastReviewAt *time.Time
}

type ReviewNotificationInput struct {
	TenantID    string
	Assignments []AssignmentForReview
	ReviewID    string
	DeadlineUTC time.Time
}

type ReviewDecision struct {
	ReviewID     string
	AssignmentID string
	Decision     string // "confirmed" | "revoked"
	ReviewerID   string
}

type RevokeAssignmentInput struct {
	TenantID     string
	UserID       string
	Role         string
	AssignmentID string
	Reason       string
}

type AccessReviewAuditEntry struct {
	TenantID     string
	AssignmentID string
	UserID       string
	Role         string
	Decision     string
	ReviewID     string
	ReviewedAt   time.Time
}

type CloudAccessFinding struct {
	FindingID    string
	Cloud        string
	ResourceType string
	ResourceID   string
	PrincipalID  string
	FindingType  string // "unused_permission" | "external_access" | "excessive_permission"
	Severity     string
	RawFinding   string
}

func pendingAssignments(all []AssignmentForReview, decisions map[string]string) []AssignmentForReview {
	var pending []AssignmentForReview
	for _, a := range all {
		if _, ok := decisions[a.AssignmentID]; !ok {
			pending = append(pending, a)
		}
	}
	return pending
}
