terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
  backend "s3" {
    bucket         = "monok8s-tfstate-prod-aws"
    key            = "terraform/prod"
    region         = "us-east-1"
    dynamodb_table = "monok8s-tfstate-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = "us-east-1"
}

module "cluster" {
  source          = "../../modules/cluster-aws"
  name            = "monok8s-prod"
  region          = "us-east-1"
  node_count      = 3
}

module "org_policy" {
  source                        = "../../modules/org-policy"
  aws_org_id                    = var.aws_org_id
  aws_management_account_id     = var.aws_management_account_id
  aws_crossplane_irsa_role_name = "monok8s-crossplane-irsa"
}

variable "aws_org_id"                { description = "AWS Organizations org ID" }
variable "aws_management_account_id" { description = "AWS management account ID" }
