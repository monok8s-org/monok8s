"""
Custom command implementations for az monok8s.

Each function delegates to the monok8s CLI binary (installed in PATH) after
injecting the Azure access token as the authentication credential.
This means:
  - No separate 'az monok8s auth login' is needed — uses the active az session.
  - The Azure token is exchanged for a monok8s JWT at the API boundary.
  - All output formatting is handled by the monok8s CLI binary.
"""

import json
import subprocess
import sys
from typing import Optional

from azure.cli.core.util import CLIError


# ── Auth helper ───────────────────────────────────────────────────────────────

def _get_azure_token(cli_ctx) -> str:
    """Return the current az access token for the monok8s resource."""
    from azure.cli.core._profile import Profile
    profile = Profile(cli_ctx=cli_ctx)
    token, _, _ = profile.get_raw_token(
        resource="api://monok8s",
        subscription=cli_ctx.data.get("subscription_id"),
    )
    # token is a tuple: (token_type, token_value, token_entry)
    return token[1]


def _run(cli_ctx, args: list[str], output: str = "json") -> dict:
    """
    Run the monok8s CLI binary with the Azure token injected.
    Returns parsed JSON output.
    """
    try:
        azure_token = _get_azure_token(cli_ctx)
    except Exception as e:
        raise CLIError(f"Could not obtain Azure access token: {e}") from e

    cmd = ["monok8s", "--cloud", "azure", "--output", output] + args
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        env={
            **__import__("os").environ,
            # Pass the Azure token so monok8s CLI can exchange it for a JWT
            # without shelling out to `az account get-access-token` again.
            "MONOK8S_CLOUD_TOKEN": azure_token,
            "MONOK8S_CLOUD": "azure",
        },
    )
    if result.returncode != 0:
        raise CLIError(result.stderr.strip() or f"monok8s CLI exited with code {result.returncode}")
    if output == "json" and result.stdout.strip():
        return json.loads(result.stdout)
    return {}


# ── Tenant commands ───────────────────────────────────────────────────────────

def tenant_list(cli_ctx, status: Optional[str] = None):
    args = ["tenant", "list"]
    if status:
        args += ["--status", status]
    return _run(cli_ctx, args)


def tenant_get(cli_ctx, tenant_id: str):
    return _run(cli_ctx, ["tenant", "get", tenant_id])


def tenant_onboard(cli_ctx, name: str, plan: str = "starter",
                   owner: Optional[str] = None, wait: bool = False):
    args = ["tenant", "onboard", "--name", name, "--plan", plan]
    if owner:
        args += ["--owner", owner]
    if wait:
        args += ["--wait"]
    return _run(cli_ctx, args)


def tenant_offboard(cli_ctx, tenant_id: str, reason: str = "manual_offboard"):
    return _run(cli_ctx, ["tenant", "offboard", tenant_id,
                           "--confirm", "--reason", reason])


def tenant_resources(cli_ctx, tenant_id: str, diff: bool = False):
    args = ["tenant", "resources", tenant_id]
    if diff:
        args += ["--diff"]
    return _run(cli_ctx, args)


# ── Role commands ─────────────────────────────────────────────────────────────

def role_list(cli_ctx, tenant: str, role: Optional[str] = None,
              user: Optional[str] = None):
    args = ["role", "list", "--tenant", tenant]
    if role:
        args += ["--role", role]
    if user:
        args += ["--user", user]
    return _run(cli_ctx, args)


def role_assign(cli_ctx, tenant: str, user: str, role: str,
                expiry: Optional[str] = None):
    args = ["role", "assign", "--tenant", tenant, "--user", user, "--role", role]
    if expiry:
        args += ["--expiry", expiry]
    return _run(cli_ctx, args)


def role_revoke(cli_ctx, tenant: str, user: str, role: str):
    return _run(cli_ctx, ["role", "revoke",
                           "--tenant", tenant, "--user", user, "--role", role])


def role_sync(cli_ctx, tenant: str):
    return _run(cli_ctx, ["role", "sync", "--tenant", tenant])


# ── Drift commands ────────────────────────────────────────────────────────────

def drift_check(cli_ctx, tenant: Optional[str] = None,
                all_tenants: bool = False, severity: Optional[str] = None):
    args = ["drift", "check"]
    if tenant:
        args += ["--tenant", tenant]
    elif all_tenants:
        args += ["--all"]
    if severity:
        args += ["--severity", severity]
    return _run(cli_ctx, args)


def drift_reconcile(cli_ctx, tenant: Optional[str] = None,
                    all_tenants: bool = False,
                    revert: bool = False, dry_run: bool = False):
    args = ["drift", "reconcile"]
    if tenant:
        args += ["--tenant", tenant]
    elif all_tenants:
        args += ["--all"]
    if revert:
        args += ["--revert"]
    if dry_run:
        args += ["--dry-run"]
    return _run(cli_ctx, args)


# ── Findings commands ─────────────────────────────────────────────────────────

def findings_list(cli_ctx, tenant: Optional[str] = None,
                  severity: Optional[str] = None, cloud: Optional[str] = None,
                  status: str = "active", limit: int = 50):
    args = ["findings", "list", "--status", status, "--limit", str(limit)]
    if tenant:
        args += ["--tenant", tenant]
    if severity:
        args += ["--severity", severity]
    if cloud:
        args += ["--cloud", cloud]
    return _run(cli_ctx, args)


def findings_resolve(cli_ctx, finding_id: str, reason: Optional[str] = None):
    args = ["findings", "resolve", finding_id]
    if reason:
        args += ["--reason", reason]
    return _run(cli_ctx, args)


# ── Access review commands ────────────────────────────────────────────────────

def access_review_list(cli_ctx, tenant: Optional[str] = None, pending: bool = True):
    args = ["access-review", "list"]
    if tenant:
        args += ["--tenant", tenant]
    return _run(cli_ctx, args)


def access_review_decide(cli_ctx, review: str, assignment: str, decision: str):
    return _run(cli_ctx, ["access-review", "decide",
                           "--review", review, "--assignment", assignment,
                           "--decision", decision])


def access_review_trigger(cli_ctx, tenant: str):
    return _run(cli_ctx, ["access-review", "trigger", "--tenant", tenant])


# ── Installation commands ─────────────────────────────────────────────────────

def installation_list(cli_ctx, tenant: Optional[str] = None):
    args = ["installation", "list"]
    if tenant:
        args += ["--tenant", tenant]
    return _run(cli_ctx, args)


def installation_register(cli_ctx, tenant: str, name: str,
                           description: Optional[str] = None):
    args = ["installation", "register", "--tenant", tenant, "--name", name]
    if description:
        args += ["--description", description]
    return _run(cli_ctx, args)


def installation_revoke(cli_ctx, installation_id: str):
    return _run(cli_ctx, ["installation", "revoke", installation_id])


def installation_rotate_key(cli_ctx, installation_id: str):
    return _run(cli_ctx, ["installation", "rotate-key", installation_id])
