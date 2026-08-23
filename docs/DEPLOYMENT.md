# Deployment guide

This guide intentionally uses `example.com`. Replace every hostname and identifier with values from your own accounts. Never commit the resulting `.tfvars`, `.dev.vars`, Terraform state, credentials, or generated secrets.

## 1. Cloudflare prerequisites

- Add and activate your DNS zone.
- Enable R2.
- Create a Cloudflare Zero Trust team.
- Configure a Google identity provider and require MFA or passkeys in the Google account.
- Create a narrowly scoped Cloudflare API token for Terraform. Do not use the Global API Key.

The Terraform token needs only the resources declared in `infra/terraform`: R2, D1, KV, Queues, DNS, Tunnel, and Zero Trust Access. Worker deployment can use Wrangler's OAuth login separately.

## 2. Configure Terraform

```powershell
Copy-Item infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
```

Set the Cloudflare account and zone IDs, your domain, allowed identity, Google IdP ID, Google Cloud project, and a unique bridge token. Keep `enable_secondary_node = false` for a single-node deployment.

Pass the Cloudflare token outside the file:

```powershell
$env:TF_VAR_cloudflare_api_token = "..."
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform plan -out=orbitcid.tfplan
terraform -chdir=infra/terraform apply orbitcid.tfplan
```

Review the plan carefully. The Google Compute instance, persistent disk, static IPv4 address, snapshots, and network traffic can incur charges.

## 3. Configure Wrangler bindings

Copy Terraform's `d1_database_id` and `kv_namespace_id` outputs into `wrangler.jsonc`. Replace:

- `APP_ORIGIN` with the HTTPS admin origin
- `GATEWAY_HOST` with the isolated public gateway hostname
- example R2, D1, KV, Queue, Workflow, and dataset names if `resource_prefix` was changed

Add the two custom domains only after the Worker is ready:

```jsonc
"routes": [
  { "pattern": "ipfs.example.com", "custom_domain": true },
  { "pattern": "gateway.example.com", "custom_domain": true }
]
```

Do not expose an R2 bucket through `r2.dev`.

## 4. Generate and store secrets

Generate a new value for each purpose. Never reuse a value.

```powershell
npm run admin:hash-password
npm run secret:generate
```

Store these with `npx wrangler secret put NAME`:

- `ALLOWED_EMAIL`
- `ACCESS_TEAM_DOMAIN`
- `ACCESS_AUD`
- `ADMIN_PASSWORD_HASH`
- `SESSION_SECRET`
- `PROJECT_KEY_PEPPER`
- `RECOVERY_KEY`
- `IPNS_SIGNING_KEY`
- `REPLICATION_SIGNING_SECRET`
- `KUBO_NODE_PRIMARY_URL`
- `KUBO_NODE_PRIMARY_TOKEN`

Add secondary-node values only when the optional replica is enabled.

## 5. Migrate and deploy

```powershell
npm ci
npm run build
npm run db:migrate:remote
npm run deploy
```

Migration `0006_security_hardening.sql` intentionally invalidates any pre-release admin sessions while moving to the hashed revocable session schema.

## 6. Access and DNS boundaries

- Protect the admin hostname with the owner Access application.
- Leave the gateway hostname outside Access.
- Limit the Access bypass to `/api/v1/p/*`, `/api/v0/*`, and `/internal/replication/*`; the Worker still requires project keys or signed replication tickets on those paths.
- Do not modify unrelated DNS records. Preserve existing mail, verification, and application records.

## 7. Production activation

Before enabling a public project:

- Upload and retrieve private test content.
- Confirm anonymous private requests return `404`.
- Verify key scope, expiry, rotation, and revocation.
- Run an interrupted 1 GB upload.
- Run the planned staging storage test.
- Confirm Kubo peer reachability and independent retrieval from another peer.
- Configure billing alerts and monitoring.

Disabling an already-used secondary node should be preceded by unpublishing or unpinning its OrbitCID-managed roots and confirming the primary node is healthy.
