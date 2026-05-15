terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
  backend "azurerm" {
    resource_group_name  = "monok8s-prod"
    storage_account_name = "monok8sprod"
    container_name       = "monok8s-tfstate"
    key                  = "terraform/prod"
  }
}

provider "azurerm" {
  features {}
}

data "azurerm_subscription" "current" {}

module "cluster" {
  source          = "../../modules/cluster-azure"
  name            = "monok8s-prod"
  location        = "eastus"
  node_count      = 3
  subscription_id = data.azurerm_subscription.current.subscription_id
}

module "org_policy" {
  source                        = "../../modules/org-policy"
  azure_subscription_id         = data.azurerm_subscription.current.subscription_id
  azure_crossplane_principal_id = var.crossplane_principal_id
}

variable "crossplane_principal_id" {
  description = "Object ID of the Crossplane managed identity (allowed to make app role assignments)"
}
