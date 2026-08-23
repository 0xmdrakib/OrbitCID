# Portable OrbitCID data plane

This Compose stack runs the true IPFS portion of OrbitCID on any reputable Linux VPS or dedicated server with Docker. It is not tied to Google Cloud.

## Services

- `kubo`: persistent IPFS node, WAN DHT, Bitswap, gateway, and local RPC
- `agent`: authenticated control-plane bridge and private Kubo fallback gateway
- `tunnel`: optional Cloudflare Tunnel profile
- `backup`: on-demand portable CAR backup and restore through an encrypted rclone remote

Only the configured swarm port (default `4001/TCP+UDP`) is public. Kubo RPC `5001` and gateway `8080` bind to host loopback even when their host port numbers are changed. Never expose RPC directly to the internet.

## Start

```bash
cp .env.example .env
docker compose up -d kubo agent
# With a configured Cloudflare Tunnel token:
docker compose --profile tunnel up -d
```

Use a persistent provider disk or bind mount in production. Docker named volumes are convenient but the operator must understand where the provider stores them.

## Encrypted provider-neutral backup

Configure an rclone backend for R2, AWS S3, Google Cloud Storage, another S3-compatible service, or a second server. Wrap it with an rclone `crypt` remote, encrypt the rclone configuration itself, and keep its password in a secret manager.

Mount the encrypted config at `./rclone.conf`, set `RCLONE_REMOTE` to the crypt remote, then run:

```bash
docker compose --profile backup run --rm backup
```

Each recursive pin is exported as a portable CAR, checksummed, recorded in a manifest, and uploaded to a timestamped snapshot. This avoids copying a live datastore database.

For an automated daily backup on a systemd host, place the repository at `/opt/orbitcid` (or adjust `WorkingDirectory`), install the supplied units, and inspect the timer before enabling it:

```bash
sudo install -m 0644 systemd/orbitcid-backup.service /etc/systemd/system/
sudo install -m 0644 systemd/orbitcid-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now orbitcid-backup.timer
systemctl list-timers orbitcid-backup.timer
```

Monitor failed units and backup age; a timer is not proof that a usable snapshot exists.

Restore the newest snapshot:

```bash
docker compose --profile backup run --rm --entrypoint /usr/local/bin/restore.sh backup
```

Restore an explicit snapshot:

```bash
docker compose --profile backup run --rm --entrypoint /usr/local/bin/restore.sh backup 20260824T120000Z
```

Test restore regularly on a clean node. A backup that has never been restored is not a verified recovery plan.

## Control-plane recovery copies

OrbitCID writes paginated AES-256-GCM metadata recovery snapshots to the private recovery R2 bucket. Configure an R2 rclone remote with read-only credentials and copy that bucket into the separate encrypted backup remote on a schedule:

```bash
rclone copy r2-control:orbitcid-recovery orbitcid-crypt:orbitcid/control-plane --checksum
rclone copy r2-control:orbitcid-objects orbitcid-crypt:orbitcid/r2-objects --checksum
rclone copy r2-control:orbitcid-blocks orbitcid-crypt:orbitcid/r2-blocks --checksum
```

Download a snapshot and verify every encrypted page before relying on it:

```bash
RECOVERY_KEY=... npm run recovery:verify -- ./download-root snapshots/TIMESTAMP/manifest.json.enc ./restore.sql
```

The optional third argument writes verified restore SQL. Apply migrations to a new empty D1 database first, review the SQL locally, then import it with Wrangler. The SQL contains sensitive metadata and key hashes; protect and securely dispose of it after recovery. Existing project API keys require the original `PROJECT_KEY_PEPPER`, otherwise revoke and reissue them. Admin sessions and preview tokens are deliberately never backed up.

Keep the R2 read-only credential, backup-provider credential, encrypted rclone config password, and OrbitCID recovery key as separate secrets.
