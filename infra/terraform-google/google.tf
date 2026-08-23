locals {
  primary_kubo_nodes = {
    primary = {
      region       = var.primary_region
      zone         = var.primary_zone
      subnet_cidr  = var.primary_subnet_cidr
      bridge_token = var.bridge_token_primary
    }
  }
  secondary_kubo_nodes = var.enable_secondary_node ? {
    secondary = {
      region       = var.secondary_region
      zone         = var.secondary_zone
      subnet_cidr  = var.secondary_subnet_cidr
      bridge_token = coalesce(var.bridge_token_secondary, "")
    }
  } : {}
  kubo_nodes   = merge(local.primary_kubo_nodes, local.secondary_kubo_nodes)
  admin_domain = "ipfs.${var.domain}"
}

resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "monitoring" {
  service            = "monitoring.googleapis.com"
  disable_on_destroy = false
}

resource "google_compute_network" "ipfs" {
  name                    = var.resource_prefix
  auto_create_subnetworks = false
  depends_on              = [google_project_service.compute]
}

resource "google_compute_subnetwork" "ipfs" {
  for_each      = local.kubo_nodes
  name          = "${var.resource_prefix}-${each.key}"
  region        = each.value.region
  network       = google_compute_network.ipfs.id
  ip_cidr_range = each.value.subnet_cidr
  stack_type    = "IPV4_ONLY"
}

resource "google_compute_firewall" "swarm" {
  name          = "${var.resource_prefix}-swarm"
  network       = google_compute_network.ipfs.name
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["${var.resource_prefix}-kubo"]

  allow {
    protocol = "tcp"
    ports    = ["4001"]
  }

  allow {
    protocol = "udp"
    ports    = ["4001"]
  }
}

resource "google_compute_firewall" "iap_ssh" {
  name          = "${var.resource_prefix}-iap-ssh"
  network       = google_compute_network.ipfs.name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["${var.resource_prefix}-kubo"]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_service_account" "kubo" {
  account_id   = "${var.resource_prefix}-kubo"
  display_name = "OrbitCID Kubo replication nodes"
}

resource "google_project_iam_member" "kubo_monitoring" {
  project = var.google_project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.kubo.email}"
}

resource "google_project_iam_member" "kubo_logging" {
  project = var.google_project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.kubo.email}"
}

resource "google_compute_address" "kubo" {
  for_each     = local.kubo_nodes
  name         = "${var.resource_prefix}-${each.key}"
  region       = each.value.region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
}

resource "google_compute_disk" "kubo_data" {
  for_each                  = local.kubo_nodes
  name                      = "${var.resource_prefix}-${each.key}-data"
  zone                      = each.value.zone
  type                      = "pd-ssd"
  size                      = var.kubo_disk_size_gb
  physical_block_size_bytes = 4096
}

resource "google_compute_resource_policy" "snapshots" {
  for_each = local.kubo_nodes
  name     = "${var.resource_prefix}-${each.key}-snapshots"
  region   = each.value.region
  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "03:00"
      }
    }

    retention_policy {
      max_retention_days    = 14
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }

    snapshot_properties {
      storage_locations = [each.value.region]
      guest_flush       = true
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "snapshots" {
  for_each = local.kubo_nodes
  name     = google_compute_resource_policy.snapshots[each.key].name
  disk     = google_compute_disk.kubo_data[each.key].name
  zone     = each.value.zone
}

resource "google_compute_instance" "kubo" {
  for_each     = local.kubo_nodes
  name         = "${var.resource_prefix}-${each.key}"
  zone         = each.value.zone
  machine_type = var.kubo_machine_type
  tags         = ["${var.resource_prefix}-kubo"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = 20
      type  = "pd-balanced"
    }
  }

  attached_disk {
    source      = google_compute_disk.kubo_data[each.key].id
    device_name = "ipfs-data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.ipfs[each.key].id
    access_config {
      nat_ip       = google_compute_address.kubo[each.key].address
      network_tier = "PREMIUM"
    }
  }

  service_account {
    email  = google_service_account.kubo.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    startup-script = templatefile("${path.module}/../kubo/startup.sh.tftpl", {
      bridge_source     = filebase64("${path.module}/../kubo/bridge.mjs")
      bridge_token      = each.value.bridge_token
      cloudflared_token = data.cloudflare_zero_trust_tunnel_cloudflared_token.kubo[each.key].token
      kubo_image        = var.kubo_image
      admin_origin      = "https://${local.admin_domain}"
    })
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  deletion_protection = true
  depends_on = [
    google_project_service.compute,
    google_compute_disk_resource_policy_attachment.snapshots,
  ]
}
