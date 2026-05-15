# monok8s Azure CLI extension

Adds `az monok8s` commands to the Azure CLI.

## Install

```bash
az extension add --source ./apps/cli/extensions/azure/
```

From the release index (once published):
```bash
az extension add --name monok8s
```

## Usage

```bash
az monok8s tenant list
az monok8s role assign --tenant <id> --user alice@example.com --role admin
az monok8s drift check --tenant <id> --diff
az monok8s findings list --severity high --cloud azure
az monok8s access-review list --pending
```

Uses the current `az login` session. No separate login required.
