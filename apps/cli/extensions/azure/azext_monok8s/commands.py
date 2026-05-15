"""Command table for az monok8s."""

from azure.cli.core.commands import CliCommandType


def load_command_table(self, _args):
    with self.command_group("monok8s tenant") as g:
        g.custom_command("list", "tenant_list")
        g.custom_command("get", "tenant_get")
        g.custom_command("onboard", "tenant_onboard")
        g.custom_command("offboard", "tenant_offboard")
        g.custom_command("resources", "tenant_resources")

    with self.command_group("monok8s role") as g:
        g.custom_command("list", "role_list")
        g.custom_command("assign", "role_assign")
        g.custom_command("revoke", "role_revoke")
        g.custom_command("sync", "role_sync")

    with self.command_group("monok8s drift") as g:
        g.custom_command("check", "drift_check")
        g.custom_command("reconcile", "drift_reconcile")

    with self.command_group("monok8s findings") as g:
        g.custom_command("list", "findings_list")
        g.custom_command("resolve", "findings_resolve")

    with self.command_group("monok8s access-review") as g:
        g.custom_command("list", "access_review_list")
        g.custom_command("decide", "access_review_decide")
        g.custom_command("trigger", "access_review_trigger")

    with self.command_group("monok8s installation") as g:
        g.custom_command("list", "installation_list")
        g.custom_command("register", "installation_register")
        g.custom_command("revoke", "installation_revoke")
        g.custom_command("rotate-key", "installation_rotate_key")
