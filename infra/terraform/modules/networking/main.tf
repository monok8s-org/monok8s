variable "name"   { type = string }
variable "region" { type = string }

resource "google_compute_network" "main" {
  name                    = var.name
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.name}-nodes"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.0.0.0/20"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.1.0.0/16"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.2.0.0/20"
  }
}

output "network_name"    { value = google_compute_network.main.name }
output "subnetwork_name" { value = google_compute_subnetwork.main.name }
