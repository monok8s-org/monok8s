package cmd

import (
	"context"
	"fmt"
	"os"

	"github.com/monok8s/monok8s/apps/cli/internal/client"
	"github.com/spf13/cobra"
)

// Global flags shared by all subcommands.
var (
	flagAPIEndpoint string
	flagAPIKey      string
	flagOutput      string // "table" | "json" | "yaml"
	flagCloud       string // "gcp" | "aws" | "azure" | "" (auto-detect)
)

func NewRootCmd() *cobra.Command {
	root := &cobra.Command{
		Use:   "monok8s",
		Short: "Manage monok8s resources from the command line",
		Long: `monok8s CLI — fine-grained management of tenants, roles, installations,
and cloud IAM state directly from your terminal.

Authentication (in precedence order):
  1. --api-key flag or MONOK8S_API_KEY env var
  2. Cloud identity auto-detected from active gcloud/aws/az session
     (exchanges the cloud token for a monok8s JWT via SSO federation)
  3. Credentials in ~/.monok8s/config (written by 'monok8s auth login')

Output formats: table (default), json, yaml  (-o flag)

The --cloud flag overrides auto-detection when multiple cloud CLIs are
present in PATH. Valid values: gcp, aws, azure.`,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			// Skip auth check for commands that don't need it.
			if cmd.Name() == "version" || cmd.Name() == "completion" {
				return nil
			}
			return initClient(cmd)
		},
	}

	root.PersistentFlags().StringVarP(&flagAPIEndpoint, "endpoint", "e",
		envOr("MONOK8S_ENDPOINT", "https://api.monok8s.io"),
		"monok8s API endpoint")
	root.PersistentFlags().StringVar(&flagAPIKey, "api-key",
		os.Getenv("MONOK8S_API_KEY"),
		"API key (or set MONOK8S_API_KEY)")
	root.PersistentFlags().StringVarP(&flagOutput, "output", "o", "table",
		"Output format: table, json, yaml")
	root.PersistentFlags().StringVar(&flagCloud, "cloud", "",
		"Cloud provider override: gcp, aws, azure (default: auto-detect)")

	root.AddCommand(
		newVersionCmd(),
		newAuthCmd(),
		newTenantCmd(),
		newRoleCmd(),
		newDriftCmd(),
		newInstallationCmd(),
		newFindingsCmd(),
		newAccessReviewCmd(),
		newCompletionCmd(root),
	)
	return root
}

// clientKey is stored in cobra's context via SetContext so subcommands can retrieve it.
type clientKey struct{}

func initClient(cmd *cobra.Command) error {
	c, err := client.New(client.Config{
		Endpoint: flagAPIEndpoint,
		APIKey:   flagAPIKey,
		Cloud:    flagCloud,
	})
	if err != nil {
		return fmt.Errorf("authentication failed: %w\n\nRun 'monok8s auth login' to configure credentials", err)
	}
	cmd.SetContext(context.WithValue(cmd.Context(), clientKey{}, c))
	return nil
}

func apiClient(cmd *cobra.Command) *client.Client {
	return cmd.Context().Value(clientKey{}).(*client.Client)
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print CLI version",
		RunE: func(cmd *cobra.Command, _ []string) error {
			fmt.Fprintln(cmd.OutOrStdout(), "monok8s CLI v0.1.0")
			return nil
		},
	}
}

func newAuthCmd() *cobra.Command {
	auth := &cobra.Command{
		Use:   "auth",
		Short: "Authenticate with the monok8s API",
	}
	auth.AddCommand(
		&cobra.Command{
			Use:   "login",
			Short: "Log in using cloud identity or API key",
			Long: `Exchanges your active cloud CLI session (gcloud/aws/az) for a
monok8s JWT and writes it to ~/.monok8s/config.

If --api-key is provided, writes the key directly without cloud exchange.`,
			RunE: func(cmd *cobra.Command, _ []string) error {
				c, err := client.Login(client.Config{
					Endpoint: flagAPIEndpoint,
					APIKey:   flagAPIKey,
					Cloud:    flagCloud,
				})
				if err != nil {
					return err
				}
				fmt.Fprintf(cmd.OutOrStdout(), "Logged in as %s\n", c.Identity())
				return nil
			},
		},
		&cobra.Command{
			Use:   "whoami",
			Short: "Print the currently authenticated identity",
			RunE: func(cmd *cobra.Command, _ []string) error {
				c := apiClient(cmd)
				fmt.Fprintln(cmd.OutOrStdout(), c.Identity())
				return nil
			},
		},
	)
	return auth
}

func newCompletionCmd(root *cobra.Command) *cobra.Command {
	return &cobra.Command{
		Use:   "completion [bash|zsh|fish|powershell]",
		Short: "Generate shell completion scripts",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			switch args[0] {
			case "bash":
				return root.GenBashCompletion(cmd.OutOrStdout())
			case "zsh":
				return root.GenZshCompletion(cmd.OutOrStdout())
			case "fish":
				return root.GenFishCompletion(cmd.OutOrStdout(), true)
			case "powershell":
				return root.GenPowerShellCompletionWithDesc(cmd.OutOrStdout())
			default:
				return fmt.Errorf("unknown shell %q", args[0])
			}
		},
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
