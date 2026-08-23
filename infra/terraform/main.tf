locals {
  admin_domain   = "ipfs.${var.domain}"
  gateway_domain = "gateway.${var.domain}"
}

resource "cloudflare_r2_bucket" "blocks" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-blocks"
}

resource "cloudflare_r2_bucket" "objects" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-objects"
}

resource "cloudflare_r2_bucket" "staging" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-staging"
}

resource "cloudflare_r2_bucket" "recovery" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-recovery"
}

resource "cloudflare_d1_database" "metadata" {
  account_id = var.account_id
  name       = "${replace(var.resource_prefix, "-", "_")}_metadata"
}

resource "cloudflare_workers_kv_namespace" "cache" {
  account_id = var.account_id
  title      = "${var.resource_prefix}-cache"
}

resource "cloudflare_queue" "jobs" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-jobs"
}

resource "cloudflare_queue" "jobs_dlq" {
  account_id = var.account_id
  name       = "${var.resource_prefix}-jobs-dlq"
}

resource "cloudflare_zero_trust_access_application" "admin" {
  account_id       = var.account_id
  name             = "OrbitCID Admin"
  domain           = local.admin_domain
  type             = "self_hosted"
  session_duration = "12h"
  allowed_idps     = [var.google_identity_provider_id]
  auto_redirect_to_identity = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "strict"
  enable_binding_cookie      = true
}

resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id     = var.account_id
  application_id = cloudflare_zero_trust_access_application.admin.id
  name           = "Owner Google account only"
  decision       = "allow"
  precedence     = 1

  include {
    email = [var.allowed_email]
  }

  require {
    login_method = [var.google_identity_provider_id]
  }
}

resource "cloudflare_zero_trust_access_application" "machine_api" {
  account_id = var.account_id
  name       = "OrbitCID Project API"
  domain     = "${local.admin_domain}/api/v1/p/*"
  type       = "self_hosted"
}

resource "cloudflare_zero_trust_access_policy" "machine_api_bypass" {
  account_id     = var.account_id
  application_id = cloudflare_zero_trust_access_application.machine_api.id
  name           = "Worker project-key authentication"
  decision       = "bypass"
  precedence     = 1

  include {
    everyone = true
  }
}

resource "cloudflare_zero_trust_access_application" "kubo_api" {
  account_id = var.account_id
  name       = "OrbitCID Kubo Facade"
  domain     = "${local.admin_domain}/api/v0/*"
  type       = "self_hosted"
}

resource "cloudflare_zero_trust_access_policy" "kubo_api_bypass" {
  account_id     = var.account_id
  application_id = cloudflare_zero_trust_access_application.kubo_api.id
  name           = "Worker project-key authentication"
  decision       = "bypass"
  precedence     = 1

  include {
    everyone = true
  }
}

resource "cloudflare_zero_trust_access_application" "replication_car" {
  account_id = var.account_id
  name       = "OrbitCID Signed Replication CAR"
  domain     = "${local.admin_domain}/internal/replication/*"
  type       = "self_hosted"
}

resource "cloudflare_zero_trust_access_policy" "replication_car_bypass" {
  account_id     = var.account_id
  application_id = cloudflare_zero_trust_access_application.replication_car.id
  name           = "Worker signed-ticket authentication"
  decision       = "bypass"
  precedence     = 1

  include {
    everyone = true
  }
}
