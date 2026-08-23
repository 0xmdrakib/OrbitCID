# Deployment guide

This guide intentionally uses `example.com`. Replace every hostname and identifier with values from your own accounts. Never commit the resulting `.tfvars`, `.dev.vars`, Terraform state, credentials, or generated secrets.

Both Terraform states can contain tunnel or application secrets. Use an encrypted, access-controlled remote backend with versioning and state locking for production, or protect the local state as a recovery credential. Keep the Cloudflare and optional GCP states separate.

## 1. Cloudflare prerequisites

- Add and activate your DNS zone.
- Enable R2.
- Create a Cloudflare Zero Trust team.
- Configure a Google identity provider and require MFA or passkeys in the Google account.
- Create a narrowly scoped Cloudflare API token for Terraform. Do not use the Global API Key.

The control-plane Terraform token needs only the resources declared in `infra/terraform`: R2, D1, KV, Queues, and Zero Trust Access. Worker custom domains are created by Wrangler only when you deliberately add the documented routes. The optional Google module has a separate token scope for Tunnel and DNS. Worker deployment can use Wrangler's OAuth login separately.

## 2. Choose dashboard placement

The React dashboard is a static Vite application.

### Same origin as the Worker

Leave `VITE_API_ORIGIN` empty, build with `npm run build:dashboard`, and let Worker Assets serve `public/`. Set `APP_ORIGIN` and `DASHBOARD_ORIGIN` to the same protected HTTPS origin.

### Vercel or another static host

Attach a custom hostname such as `dashboard.example.com` to the frontend host. It must remain under the same registrable domain as the API so the strict admin-session cookie stays same-site; do not use the default cross-site `*.vercel.app` URL in production. Set `VITE_API_ORIGIN=https://ipfs.example.com`, use `npm run build:dashboard`, and publish `public/`. The included `vercel.json` supplies these build/output defaults.

Set the Worker values separately:

```text
APP_ORIGIN=https://ipfs.example.com
DASHBOARD_ORIGIN=https://dashboard.example.com
```

Use an exact origin with no wildcard. Protect the dashboard and API hostnames with the intended Cloudflare Access policy. A public JavaScript bundle must never contain project API keys, bridge tokens, or cloud credentials.

## 3. Configure the Cloudflare control plane

```powershell
Copy-Item infra/terraform/terraform.tfvars.example infra/terraform/terraform.tfvars
```

Set the Cloudflare account and zone IDs, your domain, allowed identity, and Google IdP ID. This root has no Google provider or billable VM resources, so operators using another VPS do not need any Google credential.

Pass the Cloudflare token outside the file:

```powershell
$env:TF_VAR_cloudflare_api_token = "..."
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform plan -out=orbitcid.tfplan
terraform -chdir=infra/terraform apply orbitcid.tfplan
```

Review the saved plan before applying it. If you choose the optional GCP data plane, configure and apply the independent `infra/terraform-google` root afterward. It creates one protected primary node by default and keeps the secondary disabled. Separate roots prevent a Cloudflare-only plan from requesting Google credentials and keep their states independently recoverable.

```powershell
Copy-Item infra/terraform-google/terraform.tfvars.example infra/terraform-google/terraform.tfvars
terraform -chdir=infra/terraform-google init
terraform -chdir=infra/terraform-google plan -out=orbitcid-google.tfplan
terraform -chdir=infra/terraform-google apply orbitcid-google.tfplan
```

Review the GCP plan carefully. Its Compute instance, persistent disk, static IPv4 address, snapshots, and network traffic can incur charges. Operators using another VPS provider skip this root entirely and deploy the portable `infra/node` stack on their server.

## 4. Configure Wrangler bindings

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

## 5. Generate and store secrets

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

## 6. Deploy the portable true-IPFS data plane

On any reputable Linux VPS with a persistent SSD and Docker:

```bash
cd infra/node
cp .env.example .env
# Set unique secrets and the protected API origin.
docker compose up -d kubo agent
docker compose --profile tunnel up -d
```

Open only `4001/TCP` and `4001/UDP` to the public internet. The Compose file publishes Kubo RPC `5001` and gateway `8080` to host loopback only. Confirm the provider firewall and host firewall agree.

The `server` profile is applied when a new Kubo repository is initialized. Kubo runs from a pinned stable image version. Upgrade only after reading Kubo release notes, taking a backup, and testing restore.

Configure the Worker's primary-node URL and token to match the Tunnel and node agent. OrbitCID sends signed CAR imports to the agent; the agent is the only component allowed to call Kubo RPC.

## 7. Configure off-server encrypted backups

Create an rclone backend for one of:

- Cloudflare R2 or AWS S3 through the S3 backend
- Google Cloud Storage through the GCS backend
- another supported object store or remote server

Wrap the backend with an rclone `crypt` remote. Encrypt `rclone.conf` itself and keep its password in a secret manager. Mount the config at `infra/node/rclone.conf`, set `RCLONE_REMOTE`, then run:

```bash
docker compose --profile backup run --rm backup
```

The backup exports every recursive pin as a portable CAR, writes SHA-256 checksums and a root manifest, and uploads a timestamped snapshot. It does not copy a live datastore database.

Install the supplied `infra/node/systemd/orbitcid-backup.service` and `.timer` units for a randomized daily run, or use your provider's scheduler. Alert on timer failures and stale snapshot timestamps.

Test a clean restore:

```bash
docker compose --profile backup run --rm --entrypoint /usr/local/bin/restore.sh backup
```

Keep at least one backup account separate from the VPS provider. Preserve the encrypted rclone configuration password offline; losing it makes encrypted backups unrecoverable.

OrbitCID also writes paginated AES-256-GCM control-plane recovery snapshots to its private recovery bucket. Mirror the recovery, objects, and blocks buckets to the offsite crypt remote with read-only R2 credentials and verify downloaded pages using `npm run recovery:verify`. An optional output argument creates reviewed restore SQL for a freshly migrated empty D1 database. Content CARs, R2 objects/blocks, and metadata recovery snapshots are separate; a complete disaster-recovery test needs all of them.

## 8. Migrate and deploy the Worker

```powershell
npm ci
npm run build
npm run db:migrate:remote
npm run deploy
```

Migration `0006_security_hardening.sql` intentionally invalidates any pre-release admin sessions while moving to the hashed revocable session schema.

## 9. Access and DNS boundaries

- Protect the admin hostname with the owner Access application.
- Leave the gateway hostname outside Access.
- Limit the Access bypass to `/api/v1/p/*`, `/api/v0/*`, and `/internal/replication/*`; the Worker still requires project keys or signed replication tickets on those paths.
- Do not modify unrelated DNS records. Preserve existing mail, verification, and application records.

## 10. Production activation

Before enabling a public project:

- Upload and retrieve private test content.
- Confirm anonymous private requests return `404`.
- Verify key scope, expiry, rotation, and revocation.
- Run an interrupted 1 GB upload.
- Run the planned staging storage test.
- Confirm Kubo peer reachability and independent retrieval from another peer.
- Stop or isolate R2 temporarily and confirm an authorized gateway request reports `X-OrbitCID-Source: kubo-primary`.
- Restore the latest encrypted CAR snapshot into a clean Kubo data volume and retrieve a test CID.
- Configure billing alerts and monitoring.

Disabling an already-used secondary node should be preceded by unpublishing or unpinning its OrbitCID-managed roots and confirming the primary node is healthy.
