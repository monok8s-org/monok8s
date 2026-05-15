variable "name"       { type = string }
variable "region"     { type = string }
variable "node_count" { type = number; default = 3 }

resource "google_container_cluster" "main" {
  name     = var.name
  location = var.region

  remove_default_node_pool = true
  initial_node_count       = 1

  workload_identity_config {
    workload_pool = "${data.google_project.current.project_id}.svc.id.goog"
  }

  network    = google_compute_network.main.name
  subnetwork = google_compute_subnetwork.main.name

  ip_allocation_policy {}   # VPC-native (required for Workload Identity)
}

resource "google_container_node_pool" "main" {
  name       = "${var.name}-nodes"
  cluster    = google_container_cluster.main.name
  location   = var.region
  node_count = var.node_count

  node_config {
    machine_type    = "e2-standard-4"
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    workload_metadata_config { mode = "GKE_METADATA" }
  }
}

resource "google_service_account" "crossplane" {
  account_id   = "crossplane"
  display_name = "Crossplane provider SA"
}

resource "google_service_account_iam_member" "crossplane_wi" {
  service_account_id = google_service_account.crossplane.name
  role               = "roles/iam.workloadIdentityUser"
  member = "serviceAccount:${data.google_project.current.project_id}.svc.id.goog[crossplane-system/crossplane]"
}

resource "google_project_iam_member" "crossplane_editor" {
  project = data.google_project.current.project_id
  role    = "roles/editor"
  member  = "serviceAccount:${google_service_account.crossplane.email}"
}

resource "google_service_account" "iam_writeback" {
  account_id   = "iam-writeback"
  display_name = "IAM write-back worker SA"
}

resource "google_service_account_iam_member" "writeback_wi" {
  service_account_id = google_service_account.iam_writeback.name
  role               = "roles/iam.workloadIdentityUser"
  member = "serviceAccount:${data.google_project.current.project_id}.svc.id.goog[iam-writeback/iam-writeback-worker]"
}

resource "google_project_iam_member" "writeback_log_viewer" {
  project = data.google_project.current.project_id
  role    = "roles/logging.viewer"
  member  = "serviceAccount:${google_service_account.iam_writeback.email}"
}

resource "google_project_iam_member" "writeback_pubsub" {
  project = data.google_project.current.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${google_service_account.iam_writeback.email}"
}

resource "google_service_account" "nodes" {
  account_id   = "${var.name}-nodes"
  display_name = "GKE node SA"
}

data "google_project" "current" {}

output "cluster_name"             { value = google_container_cluster.main.name }
output "crossplane_sa_email"      { value = google_service_account.crossplane.email }
output "iam_writeback_sa_email"   { value = google_service_account.iam_writeback.email }
