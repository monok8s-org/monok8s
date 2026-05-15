variable "name"            { type = string }
variable "location"        { type = string }
variable "node_count"      { type = number; default = 3 }
variable "subscription_id" { type = string }

data "azurerm_client_config" "current" {}

# ── Resource group ─────────────────────────────────────────────────────────────

resource "azurerm_resource_group" "main" {
  name     = var.name
  location = var.location
}

# ── Networking ─────────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "main" {
  name                = "${var.name}-vnet"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  address_space       = ["10.0.0.0/8"]
}

resource "azurerm_subnet" "nodes" {
  name                 = "nodes"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.0.0/20"]
}

# ── AKS cluster ────────────────────────────────────────────────────────────────

resource "azurerm_kubernetes_cluster" "main" {
  name                = var.name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  dns_prefix          = var.name
  kubernetes_version  = "1.29"

  default_node_pool {
    name           = "system"
    node_count     = var.node_count
    vm_size        = "Standard_D4s_v3"
    vnet_subnet_id = azurerm_subnet.nodes.id
  }

  identity { type = "SystemAssigned" }

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  network_profile {
    network_plugin = "azure"
    network_policy = "cilium"
    service_cidr   = "10.2.0.0/20"
    dns_service_ip = "10.2.0.10"
  }
}

# ── Managed identities ─────────────────────────────────────────────────────────

resource "azurerm_user_assigned_identity" "crossplane" {
  name                = "${var.name}-crossplane"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_role_assignment" "crossplane_contributor" {
  scope                = "/subscriptions/${var.subscription_id}"
  role_definition_name = "Contributor"
  principal_id         = azurerm_user_assigned_identity.crossplane.principal_id
}

resource "azurerm_federated_identity_credential" "crossplane" {
  name                = "crossplane-federated"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.crossplane.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject             = "system:serviceaccount:crossplane-system:crossplane"
}

resource "azurerm_user_assigned_identity" "iam_writeback" {
  name                = "${var.name}-iam-writeback"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
}

resource "azurerm_role_assignment" "writeback_monitoring" {
  scope                = "/subscriptions/${var.subscription_id}"
  role_definition_name = "Monitoring Reader"
  principal_id         = azurerm_user_assigned_identity.iam_writeback.principal_id
}

resource "azurerm_federated_identity_credential" "iam_writeback" {
  name                = "writeback-federated"
  resource_group_name = azurerm_resource_group.main.name
  parent_id           = azurerm_user_assigned_identity.iam_writeback.id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.main.oidc_issuer_url
  subject             = "system:serviceaccount:iam-writeback:iam-writeback-worker"
}

# ── Storage (Terraform state + tenant object storage) ──────────────────────────

resource "azurerm_storage_account" "main" {
  name                     = replace("${var.name}prod", "-", "")
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "ZRS"
  min_tls_version          = "TLS1_2"
}

resource "azurerm_storage_container" "tfstate" {
  name                  = "monok8s-tfstate"
  storage_account_name  = azurerm_storage_account.main.name
  container_access_type = "private"
}

# ── Key Vault ──────────────────────────────────────────────────────────────────

resource "azurerm_key_vault" "main" {
  name                = "${var.name}-kv"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"
  soft_delete_retention_days = 7

  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id
    key_permissions    = ["Get", "Create", "Delete", "List", "Recover"]
    secret_permissions = ["Get", "Set", "Delete", "List", "Recover"]
  }
}

# ── Outputs ────────────────────────────────────────────────────────────────────

output "cluster_name"                  { value = azurerm_kubernetes_cluster.main.name }
output "resource_group"                { value = azurerm_resource_group.main.name }
output "oidc_issuer_url"               { value = azurerm_kubernetes_cluster.main.oidc_issuer_url }
output "crossplane_client_id"          { value = azurerm_user_assigned_identity.crossplane.client_id }
output "iam_writeback_client_id"       { value = azurerm_user_assigned_identity.iam_writeback.client_id }
output "iam_writeback_principal_id"    { value = azurerm_user_assigned_identity.iam_writeback.principal_id }
output "storage_account_name"          { value = azurerm_storage_account.main.name }
output "key_vault_uri"                 { value = azurerm_key_vault.main.vault_uri }
