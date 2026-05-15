"""
monok8s AWS CLI plugin.

Adds `aws monok8s` commands that wrap the monok8s CLI using the active
AWS credentials session for authentication — no separate login required.

Install:
  pip install ./apps/cli/extensions/aws/
  # Add to ~/.aws/config:
  [plugins]
  cli_legacy_plugin_path = <site-packages>/aws_monok8s
  monok8s = aws_monok8s

After install:
  aws monok8s tenant list
  aws monok8s role assign --tenant <id> --user alice@example.com --role admin
  aws monok8s drift check --tenant <id>

The plugin uses the current AWS session (from environment, ~/.aws/credentials,
or IAM instance role) to exchange for a monok8s JWT via STS token verification.
"""

# AWS CLI v2 plugin entry point.
# The CLI discovers this via the [plugins] section in ~/.aws/config.

def awscli_initialize(cli):
    """Called by the AWS CLI when the plugin is loaded."""
    cli.register("building-command-table.main", inject_commands)


def inject_commands(command_table, session, **kwargs):
    """Add the 'monok8s' top-level command group to the AWS CLI."""
    from aws_monok8s.commands import Monok8sCommand
    command_table["monok8s"] = Monok8sCommand(session)
