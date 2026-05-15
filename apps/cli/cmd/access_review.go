package cmd

import (
	"fmt"

	"github.com/monok8s/monok8s/apps/cli/internal/client"
	"github.com/monok8s/monok8s/apps/cli/internal/output"
	"github.com/spf13/cobra"
)

func newAccessReviewCmd() *cobra.Command {
	ar := &cobra.Command{
		Use:   "access-review",
		Short: "Manage periodic access recertification",
	}
	ar.AddCommand(
		accessReviewListCmd(),
		accessReviewDecideCmd(),
		accessReviewTriggerCmd(),
	)
	return ar
}

func accessReviewListCmd() *cobra.Command {
	var (
		flagTenantID string
		flagPending  bool
	)
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List access review assignments pending a decision",
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			reviews, err := c.ListAccessReviews(cmd.Context(), flagTenantID, flagPending)
			if err != nil {
				return err
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, reviews,
				output.Columns("REVIEW_ID", "TENANT", "USER", "ROLE", "ASSIGNED_AT", "DEADLINE"),
				output.Row(func(r any) []string {
					rv := r.(client.AccessReviewRow)
					return []string{rv.ReviewID[:8] + "...", rv.TenantID[:8] + "...",
						rv.UserEmail, rv.Role, rv.AssignedAt, rv.Deadline}
				}),
			)
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Filter by tenant ID")
	cmd.Flags().BoolVar(&flagPending, "pending", true, "Show only assignments awaiting a decision")
	return cmd
}

func accessReviewDecideCmd() *cobra.Command {
	var (
		flagReviewID     string
		flagAssignmentID string
		flagDecision     string
	)
	cmd := &cobra.Command{
		Use:   "decide",
		Short: "Submit a confirm or revoke decision for a review assignment",
		Example: `  monok8s access-review decide --review a1b2c3d4-... --assignment e5f6... --decision confirm
  monok8s access-review decide --review a1b2c3d4-... --assignment e5f6... --decision revoke`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if flagDecision != "confirm" && flagDecision != "revoke" {
				return fmt.Errorf("--decision must be 'confirm' or 'revoke'")
			}
			c := apiClient(cmd)
			if err := c.SubmitAccessReviewDecision(cmd.Context(), flagReviewID, flagAssignmentID, flagDecision); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Decision '%s' recorded for assignment %s\n",
				flagDecision, flagAssignmentID)
			return nil
		},
	}
	cmd.Flags().StringVar(&flagReviewID, "review", "", "Review ID (required)")
	cmd.Flags().StringVar(&flagAssignmentID, "assignment", "", "Assignment ID (required)")
	cmd.Flags().StringVarP(&flagDecision, "decision", "d", "", "confirm or revoke (required)")
	_ = cmd.MarkFlagRequired("review")
	_ = cmd.MarkFlagRequired("assignment")
	_ = cmd.MarkFlagRequired("decision")
	return cmd
}

// accessReviewTriggerCmd starts an out-of-cycle access review for a tenant.
// Useful when an incident requires immediate recertification rather than waiting
// for the quarterly schedule.
func accessReviewTriggerCmd() *cobra.Command {
	var flagTenantID string
	cmd := &cobra.Command{
		Use:   "trigger",
		Short: "Start an out-of-cycle access review for a tenant",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			result, err := c.TriggerAccessReview(cmd.Context(), flagTenantID)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(),
				"Access review started for tenant %s\nReview ID: %s\nOwners will receive an email notification.\n",
				flagTenantID, result.ReviewID)
			return nil
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID (required)")
	_ = cmd.MarkFlagRequired("tenant")
	return cmd
}

