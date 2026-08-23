output "kubo_nodes" {
  value = {
    for key, instance in google_compute_instance.kubo : key => {
      name        = instance.name
      zone        = instance.zone
      external_ip = google_compute_address.kubo[key].address
      bridge_url  = "https://kubo-${key}-bridge.${var.domain}"
    }
  }
}
