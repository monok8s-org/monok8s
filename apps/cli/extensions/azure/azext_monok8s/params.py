"""Argument definitions for az monok8s commands."""

from azure.cli.core.decorators import Completer


def load_arguments(self, command):  # noqa: C901
    with self.argument_context("monok8s tenant list") as c:
        c.argument("status", options_list=["--status"],
                   help="Filter by status: active, suspended, offboarding")

    with self.argument_context("monok8s tenant onboard") as c:
        c.argument("name", options_list=["--name", "-n"], required=True,
                   help="Tenant display name")
        c.argument("plan", options_list=["--plan"],
                   choices=["starter", "growth", "enterprise"], default="starter",
                   help="Plan tier")
        c.argument("owner", options_list=["--owner"],
                   help="Owner email address (invited as tenant owner)")
        c.argument("wait", options_list=["--wait"], action="store_true",
                   help="Wait for onboarding to complete")

    with self.argument_context("monok8s tenant offboard") as c:
        c.argument("tenant_id", options_list=["--tenant", "-t"], required=True)
        c.argument("reason", options_list=["--reason"], default="manual_offboard")

    with self.argument_context("monok8s tenant resources") as c:
        c.argument("tenant_id", options_list=["--tenant", "-t"], required=True)
        c.argument("diff", options_list=["--diff"], action="store_true",
                   help="Highlight divergence between Crossplane desired and cloud actual state")

    with self.argument_context("monok8s role list") as c:
        c.argument("tenant", options_list=["--tenant", "-t"], required=True)
        c.argument("role", options_list=["--role", "-r"],
                   choices=["owner", "admin", "member", "viewer", "billing_manager"])
        c.argument("user", options_list=["--user", "-u"], help="Filter by user email")

    with self.argument_context("monok8s role assign") as c:
        c.argument("tenant", options_list=["--tenant", "-t"], required=True)
        c.argument("user", options_list=["--user", "-u"], required=True)
        c.argument("role", options_list=["--role", "-r"], required=True,
                   choices=["admin", "member", "viewer", "billing_manager"])
        c.argument("expiry", options_list=["--expiry"],
                   help="Expiry for temporary grants: ISO datetime or duration (4h, 7d)")

    with self.argument_context("monok8s role revoke") as c:
        c.argument("tenant", options_list=["--tenant", "-t"], required=True)
        c.argument("user", options_list=["--user", "-u"], required=True)
        c.argument("role", options_list=["--role", "-r"], required=True,
                   choices=["admin", "member", "viewer", "billing_manager"])

    with self.argument_context("monok8s drift check") as c:
        c.argument("tenant", options_list=["--tenant", "-t"])
        c.argument("all_tenants", options_list=["--all"], action="store_true")
        c.argument("severity", options_list=["--severity"],
                   choices=["diverged", "ok"])

    with self.argument_context("monok8s drift reconcile") as c:
        c.argument("tenant", options_list=["--tenant", "-t"])
        c.argument("all_tenants", options_list=["--all"], action="store_true")
        c.argument("revert", options_list=["--revert"], action="store_true")
        c.argument("dry_run", options_list=["--dry-run"], action="store_true")

    with self.argument_context("monok8s findings list") as c:
        c.argument("tenant", options_list=["--tenant", "-t"])
        c.argument("severity", options_list=["--severity", "-s"],
                   choices=["critical", "high", "medium", "low"])
        c.argument("cloud", options_list=["--cloud"],
                   choices=["gcp", "aws", "azure"])
        c.argument("status", options_list=["--status"],
                   choices=["active", "resolved", "suppressed"], default="active")
        c.argument("limit", options_list=["--limit"], type=int, default=50)

    with self.argument_context("monok8s access-review decide") as c:
        c.argument("review", options_list=["--review"], required=True)
        c.argument("assignment", options_list=["--assignment"], required=True)
        c.argument("decision", options_list=["--decision", "-d"], required=True,
                   choices=["confirm", "revoke"])

    with self.argument_context("monok8s installation register") as c:
        c.argument("tenant", options_list=["--tenant", "-t"], required=True)
        c.argument("name", options_list=["--name", "-n"], required=True)
        c.argument("description", options_list=["--description"])
