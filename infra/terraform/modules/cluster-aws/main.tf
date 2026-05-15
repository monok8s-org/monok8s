variable "name"       { type = string }
variable "region"     { type = string }
variable "node_count" { type = number; default = 3 }

data "aws_caller_identity" "current" {}
data "aws_partition"       "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
}

# ── EKS Cluster ───────────────────────────────────────────────────────────────

resource "aws_eks_cluster" "main" {
  name     = var.name
  role_arn = aws_iam_role.cluster.arn
  version  = "1.29"

  vpc_config {
    subnet_ids = aws_subnet.private[*].id
  }

  depends_on = [aws_iam_role_policy_attachment.cluster_policy]
}

resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.name}-nodes"
  node_role_arn   = aws_iam_role.nodes.arn
  subnet_ids      = aws_subnet.private[*].id

  scaling_config {
    desired_size = var.node_count
    min_size     = 1
    max_size     = var.node_count + 2
  }

  instance_types = ["m6i.xlarge"]

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr,
  ]
}

# OIDC provider for IRSA
data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

# ── IAM roles ─────────────────────────────────────────────────────────────────

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
}

data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service"; identifiers = ["eks.amazonaws.com"] }
  }
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_role" "nodes" {
  name               = "${var.name}-nodes"
  assume_role_policy = data.aws_iam_policy_document.nodes_assume.json
}

data "aws_iam_policy_document" "nodes_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals { type = "Service"; identifiers = ["ec2.amazonaws.com"] }
  }
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  role       = aws_iam_role.nodes.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# ── IRSA: Crossplane ──────────────────────────────────────────────────────────

resource "aws_iam_role" "crossplane" {
  name               = "${var.name}-crossplane-irsa"
  assume_role_policy = data.aws_iam_policy_document.crossplane_assume.json
}

data "aws_iam_policy_document" "crossplane_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:crossplane-system:crossplane"]
    }
  }
}

resource "aws_iam_role_policy_attachment" "crossplane_admin" {
  role       = aws_iam_role.crossplane.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/AdministratorAccess"
}

# ── IRSA: IAM write-back worker ───────────────────────────────────────────────

resource "aws_iam_role" "iam_writeback" {
  name               = "${var.name}-iam-writeback-irsa"
  assume_role_policy = data.aws_iam_policy_document.writeback_assume.json
}

data "aws_iam_policy_document" "writeback_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.eks.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub"
      values   = ["system:serviceaccount:iam-writeback:iam-writeback-worker"]
    }
  }
}

resource "aws_iam_policy" "writeback" {
  name = "${var.name}-iam-writeback"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = "arn:${local.partition}:sqs:${var.region}:${local.account_id}:monok8s-iam-writeback*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "writeback" {
  role       = aws_iam_role.iam_writeback.name
  policy_arn = aws_iam_policy.writeback.arn
}

# ── S3 buckets ─────────────────────────────────────────────────────────────────

resource "aws_kms_key" "s3" {
  description             = "${var.name} S3 encryption"
  deletion_window_in_days = 14
}

resource "aws_s3_bucket" "pgbackups" {
  bucket = "monok8s-pgbackups"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pgbackups" {
  bucket = aws_s3_bucket.pgbackups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket" "temporal_archive" {
  bucket = "monok8s-temporal-archive"
}

# ── Terraform state ────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "tfstate" {
  bucket = "monok8s-tfstate-prod-aws"
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_dynamodb_table" "tfstate_lock" {
  name         = "monok8s-tfstate-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
}

# ── Outputs ────────────────────────────────────────────────────────────────────

output "cluster_name"              { value = aws_eks_cluster.main.name }
output "cluster_endpoint"          { value = aws_eks_cluster.main.endpoint }
output "oidc_provider_arn"         { value = aws_iam_openid_connect_provider.eks.arn }
output "crossplane_role_arn"       { value = aws_iam_role.crossplane.arn }
output "iam_writeback_role_arn"    { value = aws_iam_role.iam_writeback.arn }
output "pgbackups_bucket"          { value = aws_s3_bucket.pgbackups.bucket }
output "temporal_archive_bucket"   { value = aws_s3_bucket.temporal_archive.bucket }
