package cmd

import (
	"fmt"
	"strings"

	"github.com/monok8s/monok8s/apps/cli/internal/client"
	"github.com/monok8s/monok8s/apps/cli/internal/output"
	"github.com/spf13/cobra"
)

var validRoles = []string{"owner", "admin", "member", "viewer", "billing_manager"}

func newRoleCmd() *cobra.Command {
	role := &cobra.Command{
		Use:   "role",
		Short: "Manage tenant role assignments",
		Long: `Manage who has what role within a tenant.

Role assignments are written to SpiceDB (the canonical source of truth) and
projected to cloud IAM by Crossplane on the next reconciliation cycle. Changes
are visible in the cloud console within ~30s.`,
	}
	role.AddCommand(
		roleListCmd(),
		roleAssignCmd(),
		roleRevokeCmd(),
		roleSyncCmd(),
	)
	return role
}

func roleListCmd() *cobra.Command {
	var (
		flagTenantID string
		flagRole     string
		flagUser     string
	)
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List role assignments for a tenant",
		Example: `  monok8s role list --tenant 550e8400-...
  monok8s role list --tenant 550e8400-... --role admin
  monok8s role list --tenant 550e8400-... -o json | jq '.[].user_email'`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			assignments, err := c.ListRoleAssignments(cmd.Context(), flagTenantID, flagRole, flagUser)
			if err != nil {
				return err
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, assignments,
				output.Columns("USER", "ROLE", "ASSIGNED_AT", "LAST_REVIEWED"),
				output.Row(func(a any) []string {
					ra := a.(client.RoleAssignmentRow)
					reviewed := ra.LastReviewed
					if reviewed == "" {
						reviewed = "never"
					}
					return []string{ra.UserEmail, ra.Role, ra.AssignedAt, reviewed}
				}),
			)
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID (required)")
	cmd.Flags().StringVarP(&flagRole, "role", "r", "", "Filter by role")
	cmd.Flags().StringVarP(&flagUser, "user", "u", "", "Filter by user email")
	_ = cmd.MarkFlagRequired("tenant")
	return cmd
}

func roleAssignCmd() *cobra.Command {
	var (
		flagTenantID string
		flagUser     string
		flagRole     string
		flagExpiry   string // ISO 8601 duration or datetime for temporary grants
	)
	cmd := &cobra.Command{
		Use:   "assign",
		Short: "Assign a role to a user within a tenant",
		Long: `Assigns a role to a user in SpiceDB. Crossplane propagates the change
to the cloud IAM within ~30s.

For temporary grants, use --expiry to set a deadline. The role is automatically
revoked when the expiry time is reached (via Temporal TemporaryGrantWorkflow).

Examples:
  monok8s role assign --tenant 550e8400-... --user alice@example.com --role admin
  monok8s role assign -t 550e8400-... -u alice@example.com -r viewer --expiry 2026-05-01T00:00:00Z
  monok8s role assign -t 550e8400-... -u alice@example.com -r admin --expiry 4h`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !isValidRole(flagRole) {
				return fmt.Errorf("invalid role %q — valid roles: %s",
					flagRole, strings.Join(validRoles, ", "))
			}
			c := apiClient(cmd)
			result, err := c.AssignRole(cmd.Context(), client.AssignRoleInput{
				TenantID:  flagTenantID,
				UserEmail: flagUser,
				Role:      flagRole,
				Expiry:    flagExpiry,
			})
			if err != nil {
				return err
			}
			msg := fmt.Sprintf("Assigned %s to %s in tenant %s", flagRole, flagUser, flagTenantID)
			if result.IsTemporary {
				msg += fmt.Sprintf(" (expires %s)", result.ExpiresAt)
			}
			fmt.Fprintln(cmd.OutOrStdout(), msg)
			fmt.Fprintf(cmd.OutOrStdout(), "Cloud sync: Crossplane will project this change within ~30s\n")
			return nil
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID (required)")
	cmd.Flags().StringVarP(&flagUser, "user", "u", "", "User email address (required)")
	cmd.Flags().StringVarP(&flagRole, "role", "r", "", "Role to assign (required)")
	cmd.Flags().StringVar(&flagExpiry, "expiry", "",
		"Expiry for temporary grants: ISO datetime (2026-05-01T00:00:00Z) or duration (4h, 7d)")
	_ = cmd.MarkFlagRequired("tenant")
	_ = cmd.MarkFlagRequired("user")
	_ = cmd.MarkFlagRequired("role")
	return cmd
}

func roleRevokeCmd() *cobra.Command {
	var (
		flagTenantID string
		flagUser     string
		flagRole     string
	)
	cmd := &cobra.Command{
		Use:   "revoke",
		Short: "Revoke a role from a user within a tenant",
		Example: `  monok8s role revoke --tenant 550e8400-... --user alice@example.com --role admin`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			if err := c.RevokeRole(cmd.Context(), flagTenantID, flagUser, flagRole); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(),
				"Revoked %s from %s in tenant %s\nCloud sync: Crossplane will project this change within ~30s\n",
				flagRole, flagUser, flagTenantID)
			return nil
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID (required)")
	cmd.Flags().StringVarP(&flagUser, "user", "u", "", "User email address (required)")
	cmd.Flags().StringVarP(&flagRole, "role", "r", "", "Role to revoke (required)")
	_ = cmd.MarkFlagRequired("tenant")
	_ = cmd.MarkFlagRequired("user")
	_ = cmd.MarkFlagRequired("role")
	return cmd
}

// roleSyncCmd forces an immediate Crossplane reconciliation for a tenant's
// cloud IAM resources. Useful when a cloud change hasn't propagated yet.
func roleSyncCmd() *cobra.Command {
	var flagTenantID string
	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Force immediate Crossplane reconciliation for a tenant",
		Long: `Triggers Crossplane to immediately reconcile the tenant's cloud IAM
resources against the current SpiceDB state, rather than waiting for the
next periodic sync (default: every 10 minutes).

This annotates the Crossplane Composite Resource with
crossplane.io/paused: "false" to trigger a new reconciliation loop.`,
		Example: `  monok8s role sync --tenant 550e8400-...`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			if err := c.TriggerCrossplaneSync(cmd.Context(), flagTenantID); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Crossplane sync triggered for tenant %s\n", flagTenantID)
			fmt.Fprintf(cmd.OutOrStdout(), "Use 'monok8s drift check --tenant %s' to verify sync in ~30s\n", flagTenantID)
			return nil
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID (required)")
	_ = cmd.MarkFlagRequired("tenant")
	return cmd
}

func isValidRole(r string) bool {
	for _, v := range validRoles {
		if v == r {
			return true
		}
	}
	return false
}
