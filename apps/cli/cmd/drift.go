package cmd

import (
	"fmt"

	"github.com/monok8s/monok8s/apps/cli/internal/client"
	"github.com/monok8s/monok8s/apps/cli/internal/output"
	"github.com/spf13/cobra"
)

func newDriftCmd() *cobra.Command {
	drift := &cobra.Command{
		Use:   "drift",
		Short: "Detect and reconcile divergence between cloud IAM and SpiceDB",
		Long: `Compares the live cloud IAM state (permission sets, Entra groups, GCP IAM
bindings) against the canonical SpiceDB state for each tenant.

Divergence categories:
  missing_in_cloud — relationship exists in SpiceDB but cloud IAM has no matching
                      assignment (Crossplane sync may be pending or stuck)
  orphaned_in_cloud — cloud IAM assignment has no corresponding SpiceDB relationship
                      (write-back worker should have caught this; investigate)
  ok               — cloud and SpiceDB agree

Use 'monok8s drift reconcile' to trigger a Crossplane sync for missing_in_cloud
divergence. Orphaned assignments are reverted by the write-back worker
automatically but can be force-reverted with --revert.`,
	}
	drift.AddCommand(
		driftCheckCmd(),
		driftReconcileCmd(),
	)
	return drift
}

func driftCheckCmd() *cobra.Command {
	var (
		flagTenantID string
		flagAll      bool
		flagSeverity string
	)
	cmd := &cobra.Command{
		Use:   "check",
		Short: "Compare cloud IAM against SpiceDB for a tenant (or all tenants)",
		Example: `  # Check a specific tenant
  monok8s drift check --tenant 550e8400-...

  # Check all tenants and show only divergent ones
  monok8s drift check --all --severity diverged

  # Output as JSON for scripting
  monok8s drift check --tenant 550e8400-... -o json | jq '.[] | select(.status == "orphaned_in_cloud")'`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !flagAll && flagTenantID == "" {
				return fmt.Errorf("specify --tenant <id> or --all")
			}
			c := apiClient(cmd)
			var diffs []client.DriftRow
			var err error
			if flagAll {
				diffs, err = c.DriftCheckAll(cmd.Context(), flagSeverity)
			} else {
				diffs, err = c.DriftCheck(cmd.Context(), flagTenantID)
			}
			if err != nil {
				return err
			}

			if len(diffs) == 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "✓ No drift detected — cloud IAM matches SpiceDB")
				return nil
			}

			// Always print a summary line before the table.
			missing, orphaned := 0, 0
			for _, d := range diffs {
				switch d.Status {
				case "missing_in_cloud":
					missing++
				case "orphaned_in_cloud":
					orphaned++
				}
			}
			if missing > 0 || orphaned > 0 {
				fmt.Fprintf(cmd.OutOrStdout(),
					"⚠  Drift detected: %d missing in cloud, %d orphaned in cloud\n\n",
					missing, orphaned)
			}

			return output.Print(cmd.OutOrStdout(), flagOutput, diffs,
				output.Columns("TENANT", "USER", "ROLE", "CLOUD", "STATUS", "DETAIL"),
				output.Row(func(d any) []string {
					dr := d.(client.DriftRow)
					return []string{
						dr.TenantID[:8] + "...",
						dr.UserEmail,
						dr.Role,
						dr.Cloud,
						dr.Status,
						dr.Detail,
					}
				}),
			)
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID to check")
	cmd.Flags().BoolVar(&flagAll, "all", false, "Check all tenants")
	cmd.Flags().StringVar(&flagSeverity, "severity", "",
		"Filter: diverged (show only missing/orphaned), ok (show only matching)")
	return cmd
}

func driftReconcileCmd() *cobra.Command {
	var (
		flagTenantID string
		flagAll      bool
		flagRevert   bool
		flagDryRun   bool
	)
	cmd := &cobra.Command{
		Use:   "reconcile",
		Short: "Trigger Crossplane sync and optionally revert orphaned cloud assignments",
		Long: `Reconciles drift found by 'monok8s drift check':

  missing_in_cloud  → triggers Crossplane to re-apply the SpiceDB state to cloud IAM
  orphaned_in_cloud → reverts the cloud assignment (requires --revert; best-effort)

Without --revert, orphaned cloud assignments are only reported, not removed.
The write-back worker reverts them automatically within ~60s anyway, but --revert
is useful when you need immediate cleanup.

Use --dry-run to preview what would be changed without applying anything.`,
		Example: `  monok8s drift reconcile --tenant 550e8400-...
  monok8s drift reconcile --tenant 550e8400-... --revert
  monok8s drift reconcile --all --dry-run`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !flagAll && flagTenantID == "" {
				return fmt.Errorf("specify --tenant <id> or --all")
			}
			c := apiClient(cmd)
			result, err := c.DriftReconcile(cmd.Context(), client.DriftReconcileInput{
				TenantID: flagTenantID,
				All:      flagAll,
				Revert:   flagRevert,
				DryRun:   flagDryRun,
			})
			if err != nil {
				return err
			}
			if flagDryRun {
				fmt.Fprintln(cmd.OutOrStdout(), "[dry-run] The following changes would be applied:")
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, result.Actions,
				output.Columns("ACTION", "TENANT", "USER", "ROLE", "CLOUD"),
				output.Row(func(a any) []string {
					act := a.(client.ReconcileAction)
					return []string{act.Action, act.TenantID[:8] + "...", act.UserEmail, act.Role, act.Cloud}
				}),
			)
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID to reconcile")
	cmd.Flags().BoolVar(&flagAll, "all", false, "Reconcile all tenants")
	cmd.Flags().BoolVar(&flagRevert, "revert", false, "Also revert orphaned cloud assignments")
	cmd.Flags().BoolVar(&flagDryRun, "dry-run", false, "Show what would change without applying")
	return cmd
}

