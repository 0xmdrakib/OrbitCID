# Deployment guide

OrbitCID uses one production architecture: a hosted frontend, an isolated control database, and a persistent self-hosted Kubo backend. Cloudflare R2 is an optional per-backend encrypted backup destination, not the primary database or IPFS node.

Examples use `example.com` and blank values. Never commit database URLs, OAuth secrets, pairing files, `.env.local`, R2 credentials, or generated keys.

## 1. Control database

Create separate PostgreSQL-compatible databases or isolated branches for development, preview, and production. Use the pooled privileged URL only for authentication, migrations, and the pairing-claim service transaction.

```bash
npm --workspace frontend run db:migrate
```

The migrations create Better Auth tables plus `user_profiles`, `backend_connections`, `pairing_claims`, `user_activity`, and `user_preferences`. Every application table has forced RLS.

Generate a unique base64url tenant-role password and configure it without placing it in a SQL file:

```bash
ORBITCID_TENANT_PASSWORD='generated-value' npm --workspace frontend run db:configure-tenant
```

Build the pooled restricted-role URL with that password and store it as `TENANT_DATABASE_URL`.

```bash
npm --workspace frontend run db:verify-isolation
```

The check proves that one tenant cannot read or insert another tenant's rows and rolls its temporary data back.

## 2. Google OAuth

In Google Cloud Console:

1. Configure **APIs & Services → OAuth consent screen**.
2. Create an OAuth client of type **Web application**.
3. Add exact origins without wildcards.
4. Add exact callbacks:

```text
http://localhost:3000/api/auth/callback/google
https://app.example.com/api/auth/callback/google
```

OrbitCID requests only normal Google identity profile data. It does not require Gmail, Drive, or another Google API scope.

## 3. Vercel

Import the repository and keep the repository root as the Vercel project root. `vercel.json` builds the `frontend` workspace.

Add every variable from `frontend/.env.example`:

- `BETTER_AUTH_URL`
- `BETTER_AUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DATABASE_URL`
- `TENANT_DATABASE_URL`
- `ORBITCID_GRANT_PRIVATE_KEY`
- `ORBITCID_GRANT_PUBLIC_KEY`
- `ORBITCID_GRANT_KEY_ID`
- `TRUSTED_ORIGINS`

Generate the asymmetric grant key locally:

```bash
npm --workspace frontend run key:generate
```

Transfer its output directly into Vercel secrets. Never expose a database URL, OAuth secret, or signing key through a `NEXT_PUBLIC_` variable. Use separate credentials for preview and production.

## 4. Kubo backend

Use persistent SSD storage on a supported Docker host:

```bash
cd infra/node
cp ../../backend/.env.example ../../backend/.env
docker compose --env-file ../../backend/.env up -d --build kubo agent
```

Set `ORBITCID_FRONTEND_ORIGIN` and `ORBITCID_BACKEND_PUBLIC_URL` to exact HTTPS origins. Use Caddy, nginx, or provider ingress to terminate HTTPS and forward only the backend hostname to `127.0.0.1:8788`.

Network policy:

- allow `4001/TCP` and `4001/UDP` for libp2p
- keep Kubo RPC `5001` private
- keep the Kubo gateway `8080` private
- keep the agent `8788` on loopback behind HTTPS
- do not share frontend cookies with the backend hostname

## 5. Pairing

Create a one-time claim in the signed-in frontend, then run:

```bash
docker compose --env-file ../../backend/.env --profile pair run --rm pair
docker compose --env-file ../../backend/.env up -d agent
```

The client generates an Ed25519 key pair, proves possession, consumes the ten-minute claim atomically, downloads the frontend signing keys, and writes `pairing.json` with mode `0600` into the private agent volume.

The backend pins the grant-signing public key at pairing time. During planned signing-key rotation, retain the previous public key until its five-minute grants expire and re-pair each backend before removing it. For suspected compromise, revoke connections immediately and re-pair with a fresh key.

## 6. Optional R2 backup

Create a private R2 bucket and an S3-compatible API token limited to Object Read & Write on that bucket. Do not use the Global API Key and do not make the bucket public.

In the frontend console:

1. Select the paired backend.
2. Open **Optional offsite backup**.
3. Enter the account ID, bucket, restricted access key, prefix, and retention period.
4. Save the encrypted configuration.
5. Run a backup and monitor its status.

The credential request goes directly from the browser to the selected backend with a one-use, five-minute `backup` grant. The control database stores only a non-secret activity event. The backend stores an AES-256-GCM envelope; backup content and names are encrypted through rclone crypt before upload.

The pairing identity protects the configuration and supplies backup encryption material. Preserve an offline recovery copy of the private pairing volume. Losing it means losing access to the encrypted backup configuration and snapshots.

Restore the latest snapshot into a clean node with `docker compose exec agent node /app/backend/r2-restore.mjs`. Pass a `YYYYMMDDTHHMMSSZ` timestamp as the final argument to restore a specific snapshot.

R2 is optional. Leaving it unconfigured does not affect uploads, pins, retrieval, or public IPFS participation.

## 7. Production acceptance

- Verify Google login/logout, session revocation, and avatar rendering.
- Confirm anonymous mutation APIs return `401`.
- Run the tenant row-isolation check.
- Prove wrong-user, wrong-audience, wrong-scope, expired, and replayed grants fail.
- Confirm R2 credentials do not appear in control rows, frontend storage, logs, or status responses.
- Verify the encrypted local R2 envelope contains no plaintext access key.
- Upload 1 MiB-boundary and multi-chunk files.
- Retrieve a test CID through the authenticated backend route.
- Confirm Kubo has public peers and an independent peer can retrieve deliberately public content.
- Confirm ports `5001` and `8080` are not internet-reachable.
- Run an R2 backup and restore it into a clean Kubo volume.
- Configure disk, certificate, memory, backup-age, and billing alerts.

One node is a professional recoverable starting point, not high availability. Add a second independent replica later without changing frontend identities or existing backend connections.
