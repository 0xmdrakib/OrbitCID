# Deployment guide

This guide uses `example.com` and empty example environments. Replace them only in private provider settings. Never commit a database URL, OAuth secret, pairing file, `.env.local`, `.tfvars`, Terraform state, or generated key.

## 1. Decide which profile to deploy

The profiles are independent:

- **Vercel profile:** public Next.js UI, Google OAuth, Neon tenant state, and user-paired Kubo backends.
- **Cloudflare provider profile:** owner-operated Worker/R2/D1 service with projects, provider APIs, gateway policies, and Kubo replication.

The Vercel profile is the default for the shared frontend described below. Cloudflare remains optional; it is not required to run Kubo.

## 2. Create the Neon control database

Create separate Neon branches or projects for development, preview, and production. Use the pooled owner URL only for Better Auth, migrations, and the narrowly defined pairing claim transaction.

Set `DATABASE_URL` in your private shell and apply the schema:

```bash
npm --workspace frontend run db:migrate
```

The migration creates:

- Better Auth user, account, session, and verification tables
- `user_profiles`
- `backend_connections`
- `pairing_claims`
- `user_activity`
- `user_preferences`
- restricted `orbitcid_tenant` and internal `orbitcid_service` roles
- forced RLS policies on every application table

Generate a unique password, replace the placeholder in `frontend/migrations/0003_tenant_role_setup.example.sql`, and execute it once as the database owner. Build `TENANT_DATABASE_URL` from the same pooled host using the `orbitcid_tenant` role.

Verify the boundary before deploying:

```bash
npm --workspace frontend run db:verify-isolation
```

The check proves that user A can see only A and that an A-context transaction cannot insert a B-owned row. The test rolls back its temporary data.

## 3. Configure Google OAuth

In Google Cloud Console:

1. Open **APIs & Services → OAuth consent screen** and configure the application.
2. Open **Credentials → Create credentials → OAuth client ID**.
3. Choose **Web application**.
4. Add the exact frontend origins. Do not add wildcards.
5. Add the exact callback paths:

```text
http://localhost:3000/api/auth/callback/google
https://app.example.com/api/auth/callback/google
```

Use a different OAuth client for production if previews are available to other people. Enable MFA or passkeys on accounts allowed to administer the deployment.

OrbitCID requests the normal Google identity profile. It does not need Drive, Gmail, or other Google API scopes.

## 4. Configure Vercel secrets

Import the repository into Vercel. Keep the repository root as the project root; `vercel.json` selects the `frontend` workspace.

Add every variable from `frontend/.env.example` in **Project Settings → Environment Variables**:

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

Generate the asymmetric grant key:

```bash
npm --workspace frontend run key:generate
```

The command prints values; it does not write an environment file. Transfer them directly into Vercel secrets. The private key must never be a `NEXT_PUBLIC_` variable.

Set `BETTER_AUTH_URL` to the canonical production origin. `TRUSTED_ORIGINS` is a comma-separated allowlist for deliberate preview/custom origins; leave it empty when there are none. Redeploy after changing environment variables.

Recommended Vercel settings:

- production-only access for production database and OAuth credentials
- separate preview credentials and Neon branch when previews need authentication
- Git deployments only from reviewed branches
- deployment logs with short retention and no request-body logging

## 5. Deploy the portable Kubo backend

Use persistent SSD storage and a supported Docker host:

```bash
cd infra/node
cp .env.example .env
```

Provide private values for:

- `BRIDGE_TOKEN` — emergency/control-plane credential, at least 32 random bytes
- `ORBITCID_FRONTEND_ORIGIN` — exact canonical Vercel/custom origin
- `ORBITCID_BACKEND_PUBLIC_URL` — exact public HTTPS agent origin
- `TUNNEL_TOKEN` — only when using the Tunnel profile
- backup variables — only when enabling backups

Start the persistent node:

```bash
docker compose up -d kubo agent
docker compose --profile tunnel up -d
```

Network policy:

- allow `4001/TCP` and `4001/UDP` from the internet for libp2p
- keep `5001` Kubo RPC on loopback/container networking
- keep `8080` Kubo gateway on loopback/container networking
- keep `8788` agent on loopback and publish it only through an HTTPS reverse proxy/Tunnel
- route the backend hostname to `http://agent:8788`, never `http://kubo:5001`

The backend endpoint must not share cookies with the frontend and must not host arbitrary public HTML on the frontend origin.

## 6. Pair a Google user to the backend

In the deployed frontend:

1. Sign in with Google.
2. Create a named pairing claim.
3. Copy the one-time code.

On the backend:

```bash
docker compose --profile pair run --rm pair
docker compose up -d agent
```

Paste the code only at the terminal prompt. The pairing client:

1. Generates a backend Ed25519 key pair.
2. Signs the code, backend origin, nonce, and timestamp.
3. Redeems the claim over HTTPS.
4. Downloads the frontend public signing keys.
5. Writes `pairing.json` with mode `0600` into the private agent volume.

The browser never receives `BRIDGE_TOKEN`, the backend private key, or a permanent project key. For each operation, Vercel issues a five-minute grant containing the verified user, backend audience, scopes, expiry, and unique ID.

The backend pins the frontend grant-signing public key at pairing time. During a signing-key rotation, keep the previous public key in `ORBITCID_GRANT_PUBLIC_JWKS` until its five-minute grants have expired, then re-pair each backend before removing that key. If a signing key may be compromised, revoke every affected connection first and re-pair with a fresh key pair.

## 7. Configure encrypted backup

Create an rclone remote on R2, S3, GCS, another compatible provider, or a second server. Wrap it with rclone `crypt`, encrypt `rclone.conf`, and keep its password in a separate secret manager.

```bash
docker compose --profile backup run --rm backup
docker compose --profile backup run --rm --entrypoint /usr/local/bin/restore.sh backup
```

The backup exports recursive pins to CAR, writes checksums and a manifest, then transfers ciphertext. Install the supplied systemd timer for scheduled runs and alert on missed backups. A production launch requires a clean-volume restore test.

## 8. Optional Cloudflare provider profile

Operators who need the existing project/R2 provider features can deploy `infra/terraform` and the root Worker separately. Use a narrowly scoped Cloudflare API token. Review every Terraform plan and preserve unrelated DNS records.

The Cloudflare profile provisions its own Worker, D1, R2, KV, queues, workflows, Access policies, and gateway boundaries. Follow the values in the root `.dev.vars.example`, `wrangler.jsonc`, and `infra/terraform/terraform.tfvars.example`. Do not expose an R2 bucket through `r2.dev`.

The optional `infra/terraform-google` root creates one Kubo node by default. It is separate so users of another VPS do not need Google Cloud credentials. A second node remains optional.

## 9. Production acceptance

Before real content:

- Verify Google login, logout, session revocation, and avatar rendering.
- Confirm anonymous mutation APIs return `401`.
- Run the Neon RLS isolation check.
- Pair a backend and verify a wrong user/audience/scope grant is rejected.
- Confirm replaying one mutation grant returns `401`.
- Upload at the 1 MiB boundary and a multi-chunk file.
- Retrieve the CID through the authenticated backend route.
- Confirm Kubo has public peers and retrieve a deliberately public test CID from an independent IPFS peer.
- Verify that `5001` and `8080` are not internet-reachable.
- Run a large interrupted upload test appropriate to the server and reverse proxy limits.
- Restore the latest encrypted CAR snapshot into a clean Kubo volume.
- Configure disk, memory, certificate, backup, and billing alerts.

One node is not high availability. It is a valid professional starting profile when monitored and recoverable; add an independent replica later without changing the frontend identity or connection model.
