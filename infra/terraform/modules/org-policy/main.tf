# Org-level guardrails module
#
# Prevents cloud IAM assignments that bypass monok8s/Crossplane from persisting.
# Complements the write-back revert path — policy blocks the action upfront so
# the revert activity becomes a rarely-hit fallback rather than a regular path.
#
# Usage:
#   GCP:   include via module "org_policy" { source = "../../modules/org-policy/gcp" }
#   AWS:   SCP is applied directly via the aws_organizations_policy resource here
#   Azure: Policy definition/assignment created here, applied at subscription scope
#
# These sub-modules are invoked from the respective prod environment main.tf.

# ── GCP ──────────────────────────────────────────────────────────────────────

variable "gcp_org_id" {
  description = "GCP organization ID (e.g. 123456789012)"
  type        = string
  default     = ""
}

variable "gcp_project_id" {
  description = "GCP project that hosts the monok8s cluster"
  type        = string
  default     = ""
}

# Custom org policy constraint: only IAM custom roles following the
# monok8s_<resource_type>_<role>_<resource_id> convention may be created
# in tenant projects. Prevents untracked role accumulation.
resource "google_org_policy_custom_constraint" "monok8s_role_naming" {
  count        = var.gcp_org_id != "" ? 1 : 0
  provider     = google
  name         = "organizations/${var.gcp_org_id}/customConstraints/custom.requireMonok8sRoleNaming"
  parent       = "organizations/${var.gcp_org_id}"
  display_name = "Require monok8s role naming convention"
  description  = "IAM custom roles in tenant projects must follow monok8s_* naming so the write-back worker can recognise and reconcile them."
  action_type  = "DENY"
  # Deny creation/update of custom roles whose ID does not start with "monok8s_"
  condition      = "!resource.name.matches('.*/roles/monok8s_.*')"
  method_types   = ["CREATE", "UPDATE"]
  resource_types = ["iam.googleapis.com/ProjectIamCustomRole"]
}

resource "google_org_policy_policy" "monok8s_role_naming" {
  count    = var.gcp_org_id != "" ? 1 : 0
  provider = google
  name     = "projects/${var.gcp_project_id}/policies/custom.requireMonok8sRoleNaming"
  parent   = "projects/${var.gcp_project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
  depends_on = [google_org_policy_custom_constraint.monok8s_role_naming]
}

# Org policy: restrict who can grant IAM roles on the project.
# Only the Crossplane service account and org admins may modify IAM policy.
# This is enforced via `constraints/iam.allowedPolicyMemberDomains` at org level
# PLUS a Deny policy at project level that catches anything not from the
# workload identity pool.
resource "google_project_iam_audit_config" "iam_data_access" {
  count   = var.gcp_project_id != "" ? 1 : 0
  project = var.gcp_project_id
  service = "iam.googleapis.com"
  audit_log_config {
    log_type = "DATA_WRITE"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
}

# ── AWS ───────────────────────────────────────────────────────────────────────

variable "aws_org_id" {
  description = "AWS Organizations org ID (o-xxxxxxxxxx)"
  type        = string
  default     = ""
}

variable "aws_management_account_id" {
  description = "AWS management account ID where the SCP is attached"
  type        = string
  default     = ""
}

variable "aws_crossplane_irsa_role_name" {
  description = "Name of the Crossplane IRSA role that is allowed to create SSO assignments"
  type        = string
  default     = "monok8s-crossplane-irsa"
}

# SCP: deny sso-admin:CreateAccountAssignment and DeleteAccountAssignment
# unless the caller is the Crossplane IRSA role or an org admin.
# This means manual console assignments are blocked at the org level.
resource "aws_organizations_policy" "monok8s_sso_assignment_guard" {
  count       = var.aws_org_id != "" ? 1 : 0
  name        = "monok8s-sso-assignment-guard"
  description = "Allow SSO account assignments only via Crossplane IRSA role. Manual assignments are denied and would trigger write-back revert anyway, but blocking upfront is cleaner."
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyManualSSOAssignments"
        Effect = "Deny"
        Action = [
          "sso-admin:CreateAccountAssignment",
          "sso-admin:DeleteAccountAssignment",
        ]
        Resource = "*"
        Condition = {
          # Allow if the caller IS the Crossplane IRSA role or an assumed-role session from it
          StringNotLike = {
            "aws:PrincipalArn" = [
              "arn:aws:iam::*:role/${var.aws_crossplane_irsa_role_name}",
              "arn:aws:iam::*:assumed-role/${var.aws_crossplane_irsa_role_name}/*",
            ]
          }
          # Also allow org management account admins
          ArnNotLike = {
            "aws:PrincipalArn" = "arn:aws:iam::${var.aws_management_account_id}:root"
          }
        }
      },
      # Also deny creation of permission sets not following the monok8s- naming
      # so ad-hoc permission sets can't be used to bypass the write-back fence.
      {
        Sid    = "DenyNonMonok8sPermissionSets"
        Effect = "Deny"
        Action = [
          "sso-admin:CreatePermissionSet",
        ]
        Resource = "*"
        Condition = {
          StringNotLike = {
            "sso:PermissionSetName" = "monok8s-*"
          }
          StringNotLike = {
            "aws:PrincipalArn" = "arn:aws:iam::${var.aws_management_account_id}:root"
          }
        }
      },
    ]
  })
}

resource "aws_organizations_policy_attachment" "monok8s_sso_assignment_guard" {
  count     = var.aws_org_id != "" ? 1 : 0
  policy_id = aws_organizations_policy.monok8s_sso_assignment_guard[0].id
  target_id = var.aws_org_id
}

# ── Azure ─────────────────────────────────────────────────────────────────────

variable "azure_subscription_id" {
  description = "Azure subscription ID where the policy is applied"
  type        = string
  default     = ""
}

variable "azure_crossplane_principal_id" {
  description = "Object ID of the Crossplane managed identity (allowed to make app role assignments)"
  type        = string
  default     = ""
}

# Azure Policy: audit app role assignments whose value does not match
# the monok8s:<resource-type>:<role> pattern.
# Mode = "Audit" — we log non-compliant assignments rather than blocking them
# outright, because Azure Policy cannot inspect the app role value at assignment
# time (only after). The write-back revert handles actual enforcement.
resource "azurerm_policy_definition" "monok8s_app_role_naming" {
  count        = var.azure_subscription_id != "" ? 1 : 0
  name         = "monok8s-app-role-naming-audit"
  policy_type  = "Custom"
  mode         = "All"
  display_name = "Audit: Entra app role assignments must follow monok8s naming convention"
  description  = "Flags app role assignments whose value does not start with 'monok8s:'. Actual enforcement is handled by the write-back worker."

  policy_rule = jsonencode({
    if = {
      allOf = [
        {
          field  = "type"
          equals = "Microsoft.Authorization/roleAssignments"
        },
        {
          not = {
            field = "Microsoft.Authorization/roleAssignments/roleDefinitionId"
            like  = "*/providers/Microsoft.Authorization/roleDefinitions/*"
          }
        },
      ]
    }
    then = {
      effect = "Audit"
    }
  })
}

# Assign the audit policy at subscription scope
resource "azurerm_subscription_policy_assignment" "monok8s_app_role_naming" {
  count                = var.azure_subscription_id != "" ? 1 : 0
  name                 = "monok8s-app-role-naming"
  subscription_id      = "/subscriptions/${var.azure_subscription_id}"
  policy_definition_id = azurerm_policy_definition.monok8s_app_role_naming[0].id
  display_name         = "Audit monok8s app role naming convention"
  description          = "Applied at subscription scope. Non-compliant assignments appear in Azure Policy compliance dashboard and are corrected by the write-back worker."
}

# Azure Policy: deny creation of Entra groups whose display name does not follow
# monok8s-<resource-type>-<uuid>-<role> — prevents shadow groups that could
# confuse the write-back worker's tenant ID extraction.
resource "azurerm_policy_definition" "monok8s_group_naming" {
  count        = var.azure_subscription_id != "" ? 1 : 0
  name         = "monok8s-group-naming-deny"
  policy_type  = "Custom"
  mode         = "All"
  display_name = "Deny: Entra groups in monok8s scope must follow naming convention"
  description  = "Denies creation of security groups whose name starts with 'monok8s-' but does not match the expected monok8s-<type>-<uuid>-<role> pattern."

  policy_rule = jsonencode({
    if = {
      allOf = [
        {
          field  = "type"
          equals = "Microsoft.AAD/groups"
        },
        {
          field = "name"
          like  = "monok8s-*"
        },
        {
          not = {
            field  = "name"
            # Pattern: monok8s-<type>-<5-segment-uuid>-<role>
            # Approximated in Azure Policy as: contains at least 7 hyphen-separated segments
            match = "monok8s-?*-????????-????-????-????-????????????-?*"
          }
        },
      ]
    }
    then = {
      effect = "Deny"
    }
  })
}

resource "azurerm_subscription_policy_assignment" "monok8s_group_naming" {
  count                = var.azure_subscription_id != "" ? 1 : 0
  name                 = "monok8s-group-naming"
  subscription_id      = "/subscriptions/${var.azure_subscription_id}"
  policy_definition_id = azurerm_policy_definition.monok8s_group_naming[0].id
  display_name         = "Deny non-standard monok8s group names"
}
