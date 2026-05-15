package cmd

import (
	"context"
	"fmt"

	"github.com/monok8s/monok8s/apps/cli/internal/client"
	"github.com/monok8s/monok8s/apps/cli/internal/output"
	"github.com/spf13/cobra"
)

func newTenantCmd() *cobra.Command {
	tenant := &cobra.Command{
		Use:   "tenant",
		Short: "Manage tenants and their cloud resources",
	}
	tenant.AddCommand(
		tenantListCmd(),
		tenantGetCmd(),
		tenantOnboardCmd(),
		tenantOffboardCmd(),
		tenantResourcesCmd(),
	)
	return tenant
}

func tenantListCmd() *cobra.Command {
	var flagStatus string
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List tenants",
		Example: `  monok8s tenant list
  monok8s tenant list --status active -o json
  monok8s tenant list | grep acme`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			tenants, err := c.ListTenants(cmd.Context(), flagStatus)
			if err != nil {
				return err
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, tenants,
				output.Columns("ID", "NAME", "STATUS", "PLAN", "CREATED_AT"),
				output.Row(func(t any) []string {
					tn := t.(client.TenantRow)
					return []string{tn.ID, tn.Name, tn.Status, tn.Plan, tn.CreatedAt}
				}),
			)
		},
	}
	cmd.Flags().StringVar(&flagStatus, "status", "", "Filter by status: active, suspended, offboarding")
	return cmd
}

func tenantGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "get <tenant-id>",
		Short:   "Get tenant details including cloud resource inventory",
		Example: `  monok8s tenant get 550e8400-e29b-41d4-a716-446655440000`,
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c := apiClient(cmd)
			tenant, err := c.GetTenant(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, tenant)
		},
	}
}

func tenantOnboardCmd() *cobra.Command {
	var (
		flagName  string
		flagPlan  string
		flagOwner string
		flagWait  bool
	)
	cmd := &cobra.Command{
		Use:   "onboard",
		Short: "Onboard a new tenant",
		Example: `  monok8s tenant onboard --name "Acme Corp" --plan growth --owner user@acme.com
  monok8s tenant onboard --name "Acme Corp" --wait   # wait for provisioning to complete`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			result, err := c.OnboardTenant(cmd.Context(), client.OnboardTenantInput{
				Name:       flagName,
				Plan:       flagPlan,
				OwnerEmail: flagOwner,
			})
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Onboarding started: tenant %s (workflow: %s)\n",
				result.TenantID, result.WorkflowID)
			if flagWait {
				return waitForWorkflow(cmd.Context(), c, result.WorkflowID, "onboarding")
			}
			return nil
		},
	}
	cmd.Flags().StringVarP(&flagName, "name", "n", "", "Tenant display name (required)")
	cmd.Flags().StringVar(&flagPlan, "plan", "starter", "Plan tier: starter, growth, enterprise")
	cmd.Flags().StringVar(&flagOwner, "owner", "", "Owner email address (invited as tenant owner)")
	cmd.Flags().BoolVarP(&flagWait, "wait", "w", false, "Wait for onboarding to complete")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func tenantOffboardCmd() *cobra.Command {
	var (
		flagConfirm bool
		flagReason  string
	)
	cmd := &cobra.Command{
		Use:   "offboard <tenant-id>",
		Short: "Begin tenant offboarding (grace period applies)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !flagConfirm {
				return fmt.Errorf("offboarding is irreversible — pass --confirm to proceed")
			}
			c := apiClient(cmd)
			result, err := c.OffboardTenant(cmd.Context(), args[0], flagReason)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(),
				"Offboarding started for tenant %s. Resources will be deleted after the grace period.\nWorkflow: %s\n",
				args[0], result.WorkflowID)
			return nil
		},
	}
	cmd.Flags().BoolVar(&flagConfirm, "confirm", false, "Confirm the destructive operation")
	cmd.Flags().StringVar(&flagReason, "reason", "manual_offboard", "Reason for offboarding")
	return cmd
}

// tenantResourcesCmd shows the cloud resource inventory for a tenant,
// pulling live state from Crossplane (desired) and the cloud API (actual).
func tenantResourcesCmd() *cobra.Command {
	var flagDiff bool
	cmd := &cobra.Command{
		Use:   "resources <tenant-id>",
		Short: "List cloud resources provisioned for a tenant",
		Long: `Shows Crossplane-managed resources for a tenant and (with --diff) highlights
any divergence between the desired state in Crossplane and the actual state in
the cloud. This is a read-only view — use 'monok8s drift reconcile' to force
a Crossplane sync if divergence is found.`,
		Example: `  monok8s tenant resources 550e8400-...
  monok8s tenant resources 550e8400-... --diff
  monok8s tenant resources 550e8400-... -o json | jq '.resources[] | select(.status == "diverged")'`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c := apiClient(cmd)
			resources, err := c.GetTenantResources(cmd.Context(), args[0], flagDiff)
			if err != nil {
				return err
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, resources,
				output.Columns("CLOUD", "TYPE", "ID", "NAME", "STATUS"),
				output.Row(func(r any) []string {
					res := r.(client.ResourceRow)
					status := res.Status
					if flagDiff && res.Status == "diverged" {
						status = "⚠ diverged"
					}
					return []string{res.Cloud, res.Type, res.ResourceID, res.Name, status}
				}),
			)
		},
	}
	cmd.Flags().BoolVar(&flagDiff, "diff", false, "Highlight divergence between Crossplane desired and cloud actual state")
	return cmd
}

func waitForWorkflow(ctx context.Context, c interface{ PollWorkflow(context.Context, string) error }, workflowID, name string) error {
	fmt.Printf("Waiting for %s workflow %s...\n", name, workflowID)
	if err := c.PollWorkflow(ctx, workflowID); err != nil {
		return fmt.Errorf("%s workflow failed: %w", name, err)
	}
	fmt.Println("Done.")
	return nil
}
