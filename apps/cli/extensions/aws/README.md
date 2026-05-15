# monok8s AWS CLI plugin

Adds `aws monok8s` commands to the AWS CLI.

## Install

```bash
pip install ./apps/cli/extensions/aws/
```

Add to `~/.aws/config`:
```ini
[plugins]
cli_legacy_plugin_path = /path/to/site-packages/aws_monok8s
monok8s = aws_monok8s
```

## Usage

```bash
aws monok8s tenant list
aws monok8s role assign --tenant <id> --user alice@example.com --role admin
aws monok8s drift check --tenant <id>
aws monok8s findings list --severity high --cloud aws
```

Uses the current AWS session credentials. No separate login required.
