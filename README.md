# OrbitCID

OrbitCID is an open-source control surface for IPFS infrastructure you own. It combines a public Vercel frontend, Google sign-in, tenant-isolated Neon state, and a persistent Kubo backend that can run on a PC, VPS, NAS, or cloud VM.

The repository does not publish a shared gateway, hosted IPFS service, or operator credentials. Each deployment supplies its own domains, OAuth application, database, node, storage, and secrets.

**Project status:** pre-1.0. Use private content first and complete the staging, backup, restore, and independent-peer checks before publishing important data.

---

## Overview

OrbitCID separates identity, control state, and file storage:

1. **Frontend — Vercel:** A Next.js application anyone may inspect. Google sign-in is required before a user can connect a backend, upload, pin, or read private activity.
2. **Control state — Neon:** Better Auth sessions, backend connections, preferences, and activity rows. Every application table has `user_id`; a restricted database role and forced Postgres Row-Level Security isolate tenants.
3. **IPFS backend — your server:** A persistent Kubo node plus the OrbitCID agent. File bytes stream directly between the browser and this backend; they do not pass through Vercel or Neon.

The portable data plane is true IPFS. Kubo participates in libp2p, DHT, Bitswap, and the public IPFS network when its swarm port is reachable. Kubo RPC and its local HTTP gateway remain private.

## Features

- Public, responsive frontend with Google login/logout and the signed-in account avatar
- Database-backed, revocable Better Auth sessions with secure cookies, OAuth state, and PKCE
- Neon tenant records protected by application authorization and forced Postgres RLS
- One-time, 256-bit, ten-minute backend pairing claims stored only as SHA-256 hashes
- Ed25519 proof of backend-key possession during pairing
- Five-minute grants bound to one Google user, one backend audience, and explicit scopes
- One-time mutation grant IDs to reduce replay risk
- Direct browser-to-Kubo streaming uploads with CIDv1, SHA-256, 1 MiB chunks, and raw leaves
- Recursive pin listing, add, and removal without exposing Kubo RPC
- Persistent Kubo storage, public swarm connectivity, and encrypted off-server CAR backups
- Optional Cloudflare provider profile with R2/D1, projects, resumable uploads, sealed content, gateway policies, and recovery workflows
- No local authentication bypass, real environment file, private key, or hosted operator URL in the repository

## Repository layout

| Path | Purpose |
| --- | --- |
| [`frontend`](frontend) | Next.js Vercel application, Google OAuth, Neon schema, RLS, pairing and grant APIs |
| [`backend`](backend) | Portable pairing client and backend grant verifier |
| [`infra/node`](infra/node) | Docker Compose Kubo node, OrbitCID agent, Tunnel and encrypted backup jobs |
| [`src`](src) | Optional Cloudflare Worker provider control plane |
| [`dashboard`](dashboard) | Optional provider-oriented Vite dashboard |
| [`migrations`](migrations) | Cloudflare D1 provider migrations |
| [`infra/terraform`](infra/terraform) | Optional Cloudflare infrastructure |
| [`infra/terraform-google`](infra/terraform-google) | Optional single-node Google Cloud deployment |

## Deployment profiles

### Portable Vercel profile

Use this profile when multiple Google users should be able to sign in and pair infrastructure they own.

| Layer | Recommended deployment |
| --- | --- |
| Frontend and authenticated API | Vercel |
| User/session/control state | Neon Postgres |
| IPFS storage and network | Persistent Kubo on any suitable server |
| Backend HTTPS | Cloudflare Tunnel, Caddy, nginx, or another trusted reverse proxy |
| Offsite backup | Encrypted rclone remote on R2, S3, GCS, or a second server |

Neon does not create a physical database or “bucket” per login. OrbitCID uses logical tenant rows, a server-derived user identity, a restricted database role, and RLS. Browser input never chooses the effective `user_id`.

### Cloudflare provider profile

The existing Worker profile remains available for an owner-operated IPFS provider. It includes project-scoped files, pins, API keys, quotas, visibility, R2 block storage, D1 metadata, queues, recovery exports, and optional Kubo replication. It can be deployed independently of the Vercel profile.

## Local verification

Use Node.js 22 or newer. Docker is required only for live Kubo and backup tests.

```bash
git clone https://github.com/0xmdrakib/OrbitCID.git
cd OrbitCID
npm ci
npm run security:release
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Real authentication bypasses are intentionally unavailable. For authenticated local development, use a real Google OAuth development client and a disposable local Postgres database, or deploy a protected preview with separate credentials.

## Deploy the Vercel frontend

1. Create a Neon project and use its pooled owner connection as `DATABASE_URL`.
2. Run `npm --workspace frontend run db:migrate`.
3. Generate a unique password, execute [`frontend/migrations/0003_tenant_role_setup.example.sql`](frontend/migrations/0003_tenant_role_setup.example.sql) after replacing its placeholder, and store the pooled restricted-role URL as `TENANT_DATABASE_URL`.
4. Run `npm --workspace frontend run db:verify-isolation` using the owner URL.
5. Create a Google OAuth **Web application**. Add these exact redirect URIs:
   - `http://localhost:3000/api/auth/callback/google` for local development
   - `https://your-frontend.example.com/api/auth/callback/google` for production
6. Copy [`frontend/.env.example`](frontend/.env.example) only as a private local `.env.local`, then provide every production value through Vercel Environment Variables.
7. Generate the backend-grant key pair with `npm --workspace frontend run key:generate`. Store its output only in Vercel secrets.
8. Import the repository into Vercel. The root [`vercel.json`](vercel.json) builds the `frontend` workspace.

Required frontend variables are documented without values in [`frontend/.env.example`](frontend/.env.example). Never prefix database URLs, Google secrets, auth secrets, or grant keys with `NEXT_PUBLIC_`.

## Deploy and pair a backend

On a persistent Linux server with Docker:

```bash
cd infra/node
cp .env.example .env
# Fill the private values and exact HTTPS origins.
docker compose up -d kubo agent
docker compose --profile tunnel up -d
```

Expose only `4001/TCP` and `4001/UDP` for the IPFS swarm. Host ports `5001`, `8080`, and `8788` bind to loopback by default. Route backend HTTPS traffic to the agent, never directly to Kubo RPC.

To pair:

1. Sign in to the deployed frontend with Google.
2. Create a named one-time pairing code.
3. On the backend, run:

```bash
docker compose --profile pair run --rm pair
```

4. Paste the code at the terminal prompt, restart the agent, and use **Test** in the frontend console.

The generated `pairing.json` stays in a private Docker volume with the backend private key and connection binding. Revoking a connection immediately prevents new grants; already issued grants expire within five minutes.

## Content behavior

- A signed-in user can upload directly to their selected backend and inspect its recursive pinset.
- Kubo returns the content CID. Use `ipfs://{cid}` for blockchain and NFT references.
- Content is public on IPFS only when it is announced or retrievable through peers; encryption is required for confidential payloads.
- Removing your pin does not recall copies already retained by other IPFS peers.
- One Kubo node is recoverable but not highly available. Add another independent replica when uptime justifies the cost.

## Backup and recovery

The portable backup job exports recursive pins as CAR files, records SHA-256 checksums, and sends encrypted snapshots to a provider-neutral rclone target. It never copies a live datastore database.

```bash
docker compose --profile backup run --rm backup
docker compose --profile backup run --rm --entrypoint /usr/local/bin/restore.sh backup
```

Keep the VPS account, backup account, encryption password, Google OAuth secret, Neon credentials, and grant-signing key as separate recovery factors. Test a clean restore before depending on a backup.

## Security

- Keep `.env`, `.env.local`, `.dev.vars`, deploy-time `.tfvars`, Terraform state, pairing files, and generated secrets outside Git.
- Use exact HTTPS origins and no wildcard CORS for authenticated backend calls.
- Do not expose Kubo RPC, the local Kubo gateway, or the emergency bridge token.
- Use different databases and OAuth clients for preview and production.
- Restrict Vercel production secrets to the production environment when possible.
- Review the [threat model](docs/THREAT_MODEL.md) and [deployment guide](docs/DEPLOYMENT.md) before launch.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/0xmdrakib/OrbitCID/security/advisories/new), not a public issue.

## License

This project is licensed under the [MIT License](./LICENSE).
