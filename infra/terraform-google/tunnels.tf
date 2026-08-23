resource "random_id" "tunnel_secret" {
  for_each    = local.kubo_nodes
  byte_length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "kubo" {
  for_each      = local.kubo_nodes
  account_id    = var.account_id
  name          = "${var.resource_prefix}-${each.key}"
  config_src    = "cloudflare"
  tunnel_secret = random_id.tunnel_secret[each.key].b64_std
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "kubo" {
  for_each   = local.kubo_nodes
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.kubo[each.key].id
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "kubo" {
  for_each   = local.kubo_nodes
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.kubo[each.key].id

  config = {
    ingress = [
      {
        hostname = "kubo-${each.key}-bridge.${var.domain}"
        service  = "http://bridge:8788"
        origin_request = {
          connect_timeout = 10
          no_tls_verify   = false
        }
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

resource "cloudflare_dns_record" "kubo_bridge" {
  for_each = local.kubo_nodes
  zone_id  = var.zone_id
  name     = "kubo-${each.key}-bridge.${var.domain}"
  content  = "${cloudflare_zero_trust_tunnel_cloudflared.kubo[each.key].id}.cfargotunnel.com"
  type     = "CNAME"
  proxied  = true
  ttl      = 1
}
