# Bootstrap: provisions the K8s cluster and foundational cloud resources.
# Everything above this layer is managed by Crossplane.

terraform {
  required_version = ">= 1.9"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
  backend "gcs" {
    bucket = "monok8s-tfstate-prod"
    prefix = "terraform/prod"
  }
}

module "cluster" {
  source     = "../../modules/cluster"
  name       = "monok8s-prod"
  region     = "us-central1"
  node_count = 3
}

module "networking" {
  source = "../../modules/networking"
  name   = "monok8s-prod"
  region = "us-central1"
}

module "org_policy" {
  source         = "../../modules/org-policy"
  gcp_org_id     = var.gcp_org_id
  gcp_project_id = var.gcp_project_id
}

variable "gcp_org_id"     { description = "GCP organization ID" }
variable "gcp_project_id" { description = "GCP project ID hosting the cluster" }
