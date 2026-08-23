# Optional Google Cloud Kubo module

This Terraform root is deliberately separate from `infra/terraform`. Operators using another VPS can deploy the Cloudflare control plane without installing Google credentials or downloading the Google provider.

This module creates one persistent Kubo node by default, plus its dedicated network, SSD, snapshot schedule, static IPv4 address, IAP-only SSH firewall, public swarm firewall, Cloudflare Tunnel, and bridge DNS record. The optional secondary node uses the same configuration and is disabled by default.

```powershell
Copy-Item infra/terraform-google/terraform.tfvars.example infra/terraform-google/terraform.tfvars
$env:TF_VAR_cloudflare_api_token = "..."
terraform -chdir=infra/terraform-google init
terraform -chdir=infra/terraform-google plan -out=orbitcid-google.tfplan
terraform -chdir=infra/terraform-google apply orbitcid-google.tfplan
```

Review the plan and estimated provider cost before applying. The state contains sensitive Tunnel material, so keep it in a separately protected encrypted backend and never commit it. VM deletion protection is enabled. Before intentionally removing a node, unpublish its managed roots, verify another copy and the offsite CAR backup, then disable deletion protection in a separate reviewed change.

Only swarm port `4001/TCP+UDP` is internet-facing. Kubo RPC and its local gateway are loopback/container-network only; the authenticated agent is reached through Cloudflare Tunnel.
