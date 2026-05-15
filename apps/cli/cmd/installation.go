package cmd

import (
	"fmt"

	"github.com/monok8s/monok8s/apps/cli/internal/client"
	"github.com/monok8s/monok8s/apps/cli/internal/output"
	"github.com/spf13/cobra"
)

func newInstallationCmd() *cobra.Command {
	inst := &cobra.Command{
		Use:   "installation",
		Short: "Manage Model B self-hosted installations",
	}
	inst.AddCommand(
		installationListCmd(),
		installationRegisterCmd(),
		installationRevokeCmd(),
		installationRotateKeyCmd(),
	)
	return inst
}

func installationListCmd() *cobra.Command {
	var flagTenantID string
	cmd := &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List registered installations",
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			installs, err := c.ListInstallations(cmd.Context(), flagTenantID)
			if err != nil {
				return err
			}
			return output.Print(cmd.OutOrStdout(), flagOutput, installs,
				output.Columns("ID", "NAME", "STATUS", "LAST_HEARTBEAT", "HOST"),
				output.Row(func(i any) []string {
					inst := i.(client.InstallationRow)
					return []string{inst.ID[:8] + "...", inst.Name, inst.Status, inst.LastHeartbeat, inst.Host}
				}),
			)
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Filter by tenant ID")
	return cmd
}

func installationRegisterCmd() *cobra.Command {
	var (
		flagTenantID string
		flagName     string
		flagDesc     string
	)
	cmd := &cobra.Command{
		Use:   "register",
		Short: "Register a new self-hosted installation",
		Long: `Creates a pending installation record and prints the one-time bootstrap
token. Copy the token to the Model B cluster and run:

  monok8s-cli register --bootstrap-token <token> --model-a-endpoint https://api.monok8s.io

The token expires after 24h.`,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c := apiClient(cmd)
			result, err := c.RegisterInstallation(cmd.Context(), flagTenantID, flagName, flagDesc)
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Installation registered: %s\n\n", result.InstallationID)
			fmt.Fprintf(cmd.OutOrStdout(), "Bootstrap token (shown once — copy it now):\n\n  %s\n\n", result.BootstrapToken)
			fmt.Fprintf(cmd.OutOrStdout(), "Run on the Model B cluster:\n  monok8s-cli register --bootstrap-token %s --model-a-endpoint %s\n",
				result.BootstrapToken, flagAPIEndpoint)
			return nil
		},
	}
	cmd.Flags().StringVarP(&flagTenantID, "tenant", "t", "", "Tenant ID (required)")
	cmd.Flags().StringVarP(&flagName, "name", "n", "", "Installation name (required)")
	cmd.Flags().StringVar(&flagDesc, "description", "", "Optional description")
	_ = cmd.MarkFlagRequired("tenant")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func installationRevokeCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "revoke <installation-id>",
		Short: "Revoke an installation's credentials",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c := apiClient(cmd)
			if err := c.RevokeInstallation(cmd.Context(), args[0]); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Installation %s revoked\n", args[0])
			return nil
		},
	}
	return cmd
}

func installationRotateKeyCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "rotate-key <installation-id>",
		Short: "Rotate the API key for an installation",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c := apiClient(cmd)
			result, err := c.RotateInstallationKey(cmd.Context(), args[0])
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "New API key (shown once — update the installation secret):\n\n  %s\n", result.NewKey)
			return nil
		},
	}
	return cmd
}

