variable "cloudflare_api_token" {
  description = "Cloudflare API token with Workers, D1, R2, KV, Queues, DNS and Access write permissions."
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
  description = "Short lowercase prefix used for Cloudflare resource names."
  type        = string
  default     = "orbitcid"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,24}$", var.resource_prefix))
    error_message = "resource_prefix must be 2-25 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "allowed_email" {
  description = "The single Google identity allowed into the admin application."
  type        = string
}

variable "google_identity_provider_id" {
  description = "Cloudflare Zero Trust Google login-method ID. Create the Google IdP before applying."
  type        = string
}

variable "dashboard_domain" {
  description = "Optional separate dashboard hostname, for example dashboard.example.com. Leave null when Worker Assets serve the dashboard on the admin domain."
  type        = string
  default     = null
  nullable    = true
}
