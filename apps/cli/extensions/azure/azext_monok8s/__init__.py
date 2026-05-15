"""
monok8s Azure CLI extension.

Adds `az monok8s` commands that wrap the monok8s CLI using the active
`az login` session for authentication — no separate login required.

Install:
  az extension add --source ./apps/cli/extensions/azure/
  # or from the release index:
  az extension add --name monok8s

After install:
  az monok8s tenant list
  az monok8s role assign --tenant <id> --user alice@example.com --role admin
  az monok8s drift check --tenant <id>
"""

from azure.cli.core import AzCommandsLoader
from azext_monok8s.commands import load_command_table
from azext_monok8s.params import load_arguments


class Monok8sCommandsLoader(AzCommandsLoader):
    def __init__(self, cli_ctx=None):
        from azure.cli.core.commands import CliCommandType
        custom_type = CliCommandType(operations_tmpl="azext_monok8s.custom#{}")
        super().__init__(cli_ctx=cli_ctx, custom_command_type=custom_type)

    def load_command_table(self, args):
        load_command_table(self, args)
        return self.command_table

    def load_arguments(self, command):
        load_arguments(self, command)


COMMAND_LOADER_CLS = Monok8sCommandsLoader
