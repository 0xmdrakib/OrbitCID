output "d1_database_id" {
  value = cloudflare_d1_database.metadata.id
}

output "kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.cache.id
}

output "admin_access_application_id" {
  value = cloudflare_zero_trust_access_application.admin.id
}

output "admin_access_aud" {
  value = cloudflare_zero_trust_access_application.admin.aud
}

output "resource_names" {
  value = {
    blocks   = cloudflare_r2_bucket.blocks.name
    objects  = cloudflare_r2_bucket.objects.name
    staging  = cloudflare_r2_bucket.staging.name
    recovery = cloudflare_r2_bucket.recovery.name
    queue     = cloudflare_queue.jobs.name
    queue_dlq = cloudflare_queue.jobs_dlq.name
  }
}

output "kubo_nodes" {
  value = {
    for key, instance in google_compute_instance.kubo : key => {
      name       = instance.name
      zone       = instance.zone
      external_ip = google_compute_address.kubo[key].address
    }
  }
}

output "gateway_domain" {
  value = local.gateway_domain
}