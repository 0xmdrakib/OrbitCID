variable "cloudflare_api_token" {
  description = "Scoped Cloudflare token for Tunnel and DNS resources."
  type        = string
  sensitive   = true
}

variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "domain" {
  type    = string
  default = "example.com"
}

variable "resource_prefix" {
  description = "Short lowercase prefix used for GCP and Tunnel resource names."
  type        = string
  default     = "orbitcid"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}$", var.resource_prefix))
    error_message = "resource_prefix must be 2-25 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "google_project_id" {
  description = "Billing-enabled Google Cloud project for the Kubo node."
  type        = string
}

variable "kubo_machine_type" {
  type    = string
  default = "e2-standard-2"
}

variable "kubo_disk_size_gb" {
  type    = number
  default = 100

  validation {
    condition     = var.kubo_disk_size_gb >= 50
    error_message = "kubo_disk_size_gb must be at least 50 GB."
  }
}

variable "kubo_image" {
  type    = string
  default = "ipfs/kubo:v0.43.0@sha256:63f5502f7a01b82a675e45bae81b2f5dfa90248ec4a86cd0a58c218347e1f2d2"
}

variable "bridge_token_primary" {
  description = "Primary replication bridge bearer token."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.bridge_token_primary) >= 32
    error_message = "bridge_token_primary must contain at least 32 characters."
  }
}

variable "bridge_token_secondary" {
  description = "Optional secondary bridge token. Required only when enable_secondary_node is true."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true

  validation {
    condition     = !var.enable_secondary_node || try(length(var.bridge_token_secondary) >= 32, false)
    error_message = "bridge_token_secondary must contain at least 32 characters when the secondary node is enabled."
  }
}

variable "primary_region" {
  type    = string
  default = "asia-south1"
}

variable "primary_zone" {
  type    = string
  default = "asia-south1-a"
}

variable "primary_subnet_cidr" {
  type    = string
  default = "10.82.0.0/24"
}

variable "secondary_region" {
  type    = string
  default = "asia-southeast1"
}

variable "secondary_zone" {
  type    = string
  default = "asia-southeast1-b"
}

variable "secondary_subnet_cidr" {
  type    = string
  default = "10.81.0.0/24"
}

variable "enable_secondary_node" {
  description = "Provision the optional secondary Kubo replica and its Cloudflare Tunnel."
  type        = bool
  default     = false
}
