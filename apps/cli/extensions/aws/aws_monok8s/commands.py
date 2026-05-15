"""
AWS CLI plugin command implementations for aws monok8s.

Uses awscli.customizations.commands.BasicCommand as the base so commands
integrate naturally with the AWS CLI (--output, --query, --profile, etc.).

Each command shells out to the monok8s CLI binary with the AWS credentials
injected via environment variables so the binary can exchange them for a JWT.
"""

import json
import os
import subprocess

from awscli.customizations.commands import BasicCommand


class Monok8sCommand(BasicCommand):
    NAME = "monok8s"
    DESCRIPTION = "Manage monok8s resources from the AWS CLI."
    SYNOPSIS = "aws monok8s <command> [options]"

    SUBCOMMANDS = [
        {"name": "tenant",       "command_class": "TenantGroup"},
        {"name": "role",         "command_class": "RoleGroup"},
        {"name": "drift",        "command_class": "DriftGroup"},
        {"name": "findings",     "command_class": "FindingsGroup"},
        {"name": "access-review","command_class": "AccessReviewGroup"},
        {"name": "installation", "command_class": "InstallationGroup"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        # Top-level `aws monok8s` with no subcommand — show help.
        self._display_help(parsed_args, parsed_globals)
        return 0


# ── Helpers ───────────────────────────────────────────────────────────────────

def _aws_env(session) -> dict:
    """
    Build an env dict that passes the current AWS session credentials to the
    monok8s CLI so it can use STS to exchange them for a monok8s JWT.
    """
    creds = session.get_credentials()
    if creds is None:
        raise RuntimeError("No AWS credentials found in session")
    frozen = creds.get_frozen_credentials()
    env = os.environ.copy()
    env["AWS_ACCESS_KEY_ID"]     = frozen.access_key
    env["AWS_SECRET_ACCESS_KEY"] = frozen.secret_key
    env["MONOK8S_CLOUD"]         = "aws"
    if frozen.token:
        env["AWS_SESSION_TOKEN"] = frozen.token
    return env


def _resolve_endpoint() -> str:
    """Read MONOK8S_ENDPOINT from the operator's env, with a stable default.

    Extracted as a named effect per code-design Rule 2
    (effect_then_interceptor; #194). The orchestrator `_run` below
    threads the resolved value into the CLI's --endpoint flag rather
    than reading env mid-flow.
    """
    return os.environ.get("MONOK8S_ENDPOINT", "https://api.monok8s.io")


def _exec_monok8s(cmd: list[str], env: dict) -> subprocess.CompletedProcess:
    """Execute the monok8s CLI binary and return the completed-process record.

    Extracted as a named effect per code-design Rule 2 (#194). The
    subprocess.run call is the IO boundary; this function is the
    smallest unit testable in isolation via subprocess monkey-patching.
    Apps/cli Python tests will land via #198.
    """
    return subprocess.run(cmd, capture_output=True, text=True, env=env)


def _run(session, args: list[str], parsed_globals=None) -> dict:
    """Run the monok8s CLI and return parsed JSON output.

    Pure orchestration: composes the command, threads env, dispatches
    via the named effect, parses the result. Every IO call lives in a
    named effect function above (#194 / Rule 2).
    """
    endpoint = _resolve_endpoint()
    cmd = ["monok8s", "--cloud", "aws", "--output", "json",
           "--endpoint", endpoint] + args

    result = _exec_monok8s(cmd, _aws_env(session))
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or
                           f"monok8s CLI exited with code {result.returncode}")
    if result.stdout.strip():
        return json.loads(result.stdout)
    return {}


# ── Command groups ────────────────────────────────────────────────────────────

class TenantGroup(BasicCommand):
    NAME = "tenant"
    DESCRIPTION = "Manage tenants and their cloud resources."
    SUBCOMMANDS = [
        {"name": "list",      "command_class": "TenantList"},
        {"name": "get",       "command_class": "TenantGet"},
        {"name": "onboard",   "command_class": "TenantOnboard"},
        {"name": "offboard",  "command_class": "TenantOffboard"},
        {"name": "resources", "command_class": "TenantResources"},
    ]


class TenantList(BasicCommand):
    NAME = "list"
    DESCRIPTION = "List tenants."
    ARG_TABLE = [
        {"name": "status", "help_text": "Filter by status: active, suspended, offboarding"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["tenant", "list"]
        if parsed_args.status:
            args += ["--status", parsed_args.status]
        result = _run(self._session, args, parsed_globals)
        print(json.dumps(result, indent=2))
        return 0


class TenantGet(BasicCommand):
    NAME = "get"
    DESCRIPTION = "Get tenant details including cloud resource inventory."
    ARG_TABLE = [
        {"name": "tenant-id", "positional_arg": True, "synopsis": "<tenant-id>"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session, ["tenant", "get", parsed_args.tenant_id])
        print(json.dumps(result, indent=2))
        return 0


class TenantOnboard(BasicCommand):
    NAME = "onboard"
    DESCRIPTION = "Onboard a new tenant."
    ARG_TABLE = [
        {"name": "name",  "required": True,  "help_text": "Tenant display name"},
        {"name": "plan",  "default": "starter", "help_text": "Plan tier: starter, growth, enterprise"},
        {"name": "owner", "help_text": "Owner email address"},
        {"name": "wait",  "action": "store_true", "help_text": "Wait for onboarding to complete"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["tenant", "onboard", "--name", parsed_args.name, "--plan", parsed_args.plan]
        if parsed_args.owner:
            args += ["--owner", parsed_args.owner]
        if parsed_args.wait:
            args += ["--wait"]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class TenantOffboard(BasicCommand):
    NAME = "offboard"
    DESCRIPTION = "Begin tenant offboarding."
    ARG_TABLE = [
        {"name": "tenant-id", "positional_arg": True, "synopsis": "<tenant-id>"},
        {"name": "reason", "default": "manual_offboard"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session,
                      ["tenant", "offboard", parsed_args.tenant_id,
                       "--confirm", "--reason", parsed_args.reason])
        print(json.dumps(result, indent=2))
        return 0


class TenantResources(BasicCommand):
    NAME = "resources"
    DESCRIPTION = "List cloud resources provisioned for a tenant."
    ARG_TABLE = [
        {"name": "tenant-id", "positional_arg": True, "synopsis": "<tenant-id>"},
        {"name": "diff", "action": "store_true",
         "help_text": "Highlight divergence between Crossplane desired and cloud actual state"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["tenant", "resources", parsed_args.tenant_id]
        if parsed_args.diff:
            args += ["--diff"]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class RoleGroup(BasicCommand):
    NAME = "role"
    DESCRIPTION = "Manage tenant role assignments."
    SUBCOMMANDS = [
        {"name": "list",   "command_class": "RoleList"},
        {"name": "assign", "command_class": "RoleAssign"},
        {"name": "revoke", "command_class": "RoleRevoke"},
        {"name": "sync",   "command_class": "RoleSync"},
    ]


class RoleList(BasicCommand):
    NAME = "list"
    DESCRIPTION = "List role assignments for a tenant."
    ARG_TABLE = [
        {"name": "tenant", "required": True},
        {"name": "role",   "help_text": "Filter by role"},
        {"name": "user",   "help_text": "Filter by user email"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["role", "list", "--tenant", parsed_args.tenant]
        if parsed_args.role:
            args += ["--role", parsed_args.role]
        if parsed_args.user:
            args += ["--user", parsed_args.user]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class RoleAssign(BasicCommand):
    NAME = "assign"
    DESCRIPTION = "Assign a role to a user within a tenant."
    ARG_TABLE = [
        {"name": "tenant", "required": True},
        {"name": "user",   "required": True, "help_text": "User email address"},
        {"name": "role",   "required": True,
         "help_text": "Role: admin, member, viewer, billing_manager"},
        {"name": "expiry", "help_text": "Expiry for temporary grants (ISO datetime or duration)"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["role", "assign",
                "--tenant", parsed_args.tenant,
                "--user", parsed_args.user,
                "--role", parsed_args.role]
        if parsed_args.expiry:
            args += ["--expiry", parsed_args.expiry]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class RoleRevoke(BasicCommand):
    NAME = "revoke"
    DESCRIPTION = "Revoke a role from a user within a tenant."
    ARG_TABLE = [
        {"name": "tenant", "required": True},
        {"name": "user",   "required": True},
        {"name": "role",   "required": True},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session,
                      ["role", "revoke",
                       "--tenant", parsed_args.tenant,
                       "--user", parsed_args.user,
                       "--role", parsed_args.role])
        print(json.dumps(result, indent=2))
        return 0


class RoleSync(BasicCommand):
    NAME = "sync"
    DESCRIPTION = "Force immediate Crossplane reconciliation for a tenant."
    ARG_TABLE = [{"name": "tenant", "required": True}]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session, ["role", "sync", "--tenant", parsed_args.tenant])
        print(json.dumps(result, indent=2))
        return 0


class DriftGroup(BasicCommand):
    NAME = "drift"
    DESCRIPTION = "Detect and reconcile divergence between cloud IAM and SpiceDB."
    SUBCOMMANDS = [
        {"name": "check",      "command_class": "DriftCheck"},
        {"name": "reconcile",  "command_class": "DriftReconcile"},
    ]


class DriftCheck(BasicCommand):
    NAME = "check"
    DESCRIPTION = "Compare cloud IAM against SpiceDB for a tenant (or all tenants)."
    ARG_TABLE = [
        {"name": "tenant",   "help_text": "Tenant ID to check"},
        {"name": "all",      "action": "store_true", "help_text": "Check all tenants"},
        {"name": "severity", "help_text": "Filter: diverged or ok"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["drift", "check"]
        if parsed_args.tenant:
            args += ["--tenant", parsed_args.tenant]
        elif parsed_args.all:
            args += ["--all"]
        if parsed_args.severity:
            args += ["--severity", parsed_args.severity]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class DriftReconcile(BasicCommand):
    NAME = "reconcile"
    DESCRIPTION = "Trigger Crossplane sync and optionally revert orphaned assignments."
    ARG_TABLE = [
        {"name": "tenant",    "help_text": "Tenant ID"},
        {"name": "all",       "action": "store_true"},
        {"name": "revert",    "action": "store_true"},
        {"name": "dry-run",   "action": "store_true"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["drift", "reconcile"]
        if parsed_args.tenant:
            args += ["--tenant", parsed_args.tenant]
        elif parsed_args.all:
            args += ["--all"]
        if parsed_args.revert:
            args += ["--revert"]
        if getattr(parsed_args, "dry_run", False):
            args += ["--dry-run"]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class FindingsGroup(BasicCommand):
    NAME = "findings"
    DESCRIPTION = "Inspect cloud security findings."
    SUBCOMMANDS = [
        {"name": "list",    "command_class": "FindingsList"},
        {"name": "resolve", "command_class": "FindingsResolve"},
    ]


class FindingsList(BasicCommand):
    NAME = "list"
    DESCRIPTION = "List active security findings."
    ARG_TABLE = [
        {"name": "tenant",   "help_text": "Filter by tenant ID"},
        {"name": "severity", "help_text": "critical, high, medium, low"},
        {"name": "cloud",    "help_text": "gcp, aws, azure"},
        {"name": "status",   "default": "active"},
        {"name": "limit",    "default": "50"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["findings", "list",
                "--status", parsed_args.status,
                "--limit",  parsed_args.limit]
        if parsed_args.tenant:
            args += ["--tenant", parsed_args.tenant]
        if parsed_args.severity:
            args += ["--severity", parsed_args.severity]
        if parsed_args.cloud:
            args += ["--cloud", parsed_args.cloud]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class FindingsResolve(BasicCommand):
    NAME = "resolve"
    DESCRIPTION = "Mark a security finding as resolved."
    ARG_TABLE = [
        {"name": "finding-id", "positional_arg": True, "synopsis": "<finding-id>"},
        {"name": "reason"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["findings", "resolve", parsed_args.finding_id]
        if parsed_args.reason:
            args += ["--reason", parsed_args.reason]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class AccessReviewGroup(BasicCommand):
    NAME = "access-review"
    DESCRIPTION = "Manage periodic access recertification."
    SUBCOMMANDS = [
        {"name": "list",    "command_class": "AccessReviewList"},
        {"name": "decide",  "command_class": "AccessReviewDecide"},
        {"name": "trigger", "command_class": "AccessReviewTrigger"},
    ]


class AccessReviewList(BasicCommand):
    NAME = "list"
    DESCRIPTION = "List access review assignments pending a decision."
    ARG_TABLE = [{"name": "tenant"}]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["access-review", "list"]
        if parsed_args.tenant:
            args += ["--tenant", parsed_args.tenant]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class AccessReviewDecide(BasicCommand):
    NAME = "decide"
    DESCRIPTION = "Submit a confirm or revoke decision."
    ARG_TABLE = [
        {"name": "review",     "required": True},
        {"name": "assignment", "required": True},
        {"name": "decision",   "required": True, "help_text": "confirm or revoke"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session,
                      ["access-review", "decide",
                       "--review", parsed_args.review,
                       "--assignment", parsed_args.assignment,
                       "--decision", parsed_args.decision])
        print(json.dumps(result, indent=2))
        return 0


class AccessReviewTrigger(BasicCommand):
    NAME = "trigger"
    DESCRIPTION = "Start an out-of-cycle access review for a tenant."
    ARG_TABLE = [{"name": "tenant", "required": True}]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session, ["access-review", "trigger",
                                       "--tenant", parsed_args.tenant])
        print(json.dumps(result, indent=2))
        return 0


class InstallationGroup(BasicCommand):
    NAME = "installation"
    DESCRIPTION = "Manage Model B self-hosted installations."
    SUBCOMMANDS = [
        {"name": "list",       "command_class": "InstallationList"},
        {"name": "register",   "command_class": "InstallationRegister"},
        {"name": "revoke",     "command_class": "InstallationRevoke"},
        {"name": "rotate-key", "command_class": "InstallationRotateKey"},
    ]


class InstallationList(BasicCommand):
    NAME = "list"
    DESCRIPTION = "List registered installations."
    ARG_TABLE = [{"name": "tenant"}]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["installation", "list"]
        if parsed_args.tenant:
            args += ["--tenant", parsed_args.tenant]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class InstallationRegister(BasicCommand):
    NAME = "register"
    DESCRIPTION = "Register a new self-hosted installation."
    ARG_TABLE = [
        {"name": "tenant",      "required": True},
        {"name": "name",        "required": True},
        {"name": "description"},
    ]

    def _run_main(self, parsed_args, parsed_globals):
        args = ["installation", "register",
                "--tenant", parsed_args.tenant,
                "--name", parsed_args.name]
        if parsed_args.description:
            args += ["--description", parsed_args.description]
        result = _run(self._session, args)
        print(json.dumps(result, indent=2))
        return 0


class InstallationRevoke(BasicCommand):
    NAME = "revoke"
    DESCRIPTION = "Revoke an installation's credentials."
    ARG_TABLE = [{"name": "installation-id", "positional_arg": True,
                  "synopsis": "<installation-id>"}]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session, ["installation", "revoke",
                                       parsed_args.installation_id])
        print(json.dumps(result, indent=2))
        return 0


class InstallationRotateKey(BasicCommand):
    NAME = "rotate-key"
    DESCRIPTION = "Rotate the API key for an installation."
    ARG_TABLE = [{"name": "installation-id", "positional_arg": True,
                  "synopsis": "<installation-id>"}]

    def _run_main(self, parsed_args, parsed_globals):
        result = _run(self._session, ["installation", "rotate-key",
                                       parsed_args.installation_id])
        print(json.dumps(result, indent=2))
        return 0
