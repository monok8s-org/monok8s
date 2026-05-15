package cmd

import (
	"fmt"

	"github.com/monok8s/monok8s/apps/cli/internal/client"
	"github.com/monok8s/monok8s/apps/cli/internal/output"
	"github.com/spf13/cobra"
)

func newFindingsCmd() *cobra.Command {
	findings := &cobra.Command{
		Use:   "findings",
		Short: "Inspect cloud security findings across tenants",
	}
	findings.AddCommand(
		findingsListCmd(),
		findingsResolveCmd(),
	)
	return findings
}

func findingsListCmd() *cobra.Command {
	var (
		flagTenantID string
		flagSeverity string
		flagCloud    string
		flagStatus   string
		flagLimit    int
	)
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List active security findings",
		Example: `  monok8s findings list
  monok8s findings list --severity high --cloud aws
  monok8s findings list --tenant 550e8400-... -o json`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			findings, err := c.ListSecurityFindings(cmd.Context(), client.FindingsFilter{
				TenantID: flagTenantID,
				Severity: flagSeverity,
				Cloud:    flagCloud,
				Status:   flagStatus,
				Limit:    flagLimit,
			})
			if err != nil {
				return err
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, findings,
				output.Columns("CLOUD", "SEVERITY", "TENANT", "TYPE", "TITLE", "RECEIVED_AT"),
				output.Row(func(f any) []string {
					fr := f.(client.FindingRow)
					tenantShort := fr.TenantID
					if len(tenantShort) > 8 {
						tenantShort = tenantShort[:8] + "..."
					}
					return []string{fr.Cloud, fr.Severity, tenantShort, fr.FindingType, fr.Title, fr.ReceivedAt}
				}),
			)
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Filter by tenant ID")
	cmd.Flags().StringVarP(&flagSeverity, "severity", "s", "",
		"Filter by severity: critical, high, medium, low")
	cmd.Flags().StringVar(&flagCloud, "cloud", "", "Filter by cloud: gcp, aws, azure")
	cmd.Flags().StringVar(&flagStatus, "status", "active", "Filter by status: active, resolved, suppressed")
	cmd.Flags().IntVar(&flagLimit, "limit", 50, "Maximum number of results")
	return cmd
}

func findingsResolveCmd() *cobra.Command {
	var flagReason string
	cmd := &cobra.Command{
		Use:   "resolve <finding-id>",
		Short: "Mark a security finding as resolved",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c := apiClient(cmd)
			if err := c.ResolveSecurityFinding(cmd.Context(), args[0], flagReason); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Finding %s marked as resolved\n", args[0])
			return nil
		},
	}
	cmd.Flags().StringVar(&flagReason, "reason", "", "Resolution reason (for audit log)")
	return cmd
}

