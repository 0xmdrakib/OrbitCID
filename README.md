# OrbitCID

**Live application:** [ipfs.rakibhq.xyz](https://ipfs.rakibhq.xyz)

OrbitCID is an open-source control surface for IPFS infrastructure you own. It combines a public web frontend, Google sign-in, tenant-isolated control state, and a persistent Kubo backend that can run on a PC, VPS, NAS, or cloud VM.

Each deployment supplies its own OAuth application, control database, domain, Kubo node, and secrets. This repository contains no hosted operator URL or real environment value.

> **Project status:** pre-1.0. Complete the security, backup, restore, and independent-peer acceptance checks before relying on OrbitCID for important production data.

---

## Architecture

1. **Hosted frontend** — anyone can inspect the public interface. Google sign-in is required before connecting a backend or performing a private action.
2. **Isolated control state** — authentication sessions, backend connections, preferences, and activity records. Enforced row-level security isolates every user.
3. **Self-hosted backend** — Kubo plus the narrow OrbitCID agent. File bytes stream directly between the browser and the user's node; they do not pass through the hosted control plane.
4. **Optional R2 backup** — a signed-in user may add a least-privilege Cloudflare R2 bucket from the console. This is optional and is not part of the primary IPFS data path.

Kubo is the true IPFS data plane. It participates in libp2p, DHT, Bitswap, and the public IPFS network when its swarm port is reachable. Kubo RPC and its local gateway stay private.

## Security properties

- Google OAuth through Better Auth with state, PKCE, secure cookies, and revocable database sessions
- Server-derived tenant identity plus a restricted database role and enforced row-level security
- 256-bit, single-use, ten-minute backend pairing claims stored only as SHA-256 hashes
- Ed25519 proof of backend-key possession during pairing
- Five-minute grants bound to one user, backend audience, and explicit scope
- One-use mutation grant IDs to reduce replay
- Exact-origin CORS and no permanent backend token in JavaScript or browser storage
- Direct browser-to-Kubo streaming with CIDv1, SHA-256, 1 MiB chunks, and raw leaves
- Kubo RPC and gateway restricted to loopback/container networking
- R2 credentials sent directly to the paired backend, AES-256-GCM encrypted at rest, and never stored by the hosted control plane
- R2 CAR snapshots encrypted with rclone crypt before upload
- No authentication bypass or real secret in the public repository

## Repository layout

| Path | Purpose |
| --- | --- |
| [`frontend`](frontend) | Next.js application, Google OAuth, tenant schema/isolation, pairing and grants |
| [`backend`](backend) | Portable pairing, grant verification, and encrypted R2 backup state |
| [`infra/node`](infra/node) | Docker Compose Kubo node, OrbitCID agent, backup and recovery tooling |
| [`docs`](docs) | Deployment and threat-model documentation |
| [`test`](test) | Pairing, grant, replay, tenant-isolation, and backup-security tests |

Frontend and backend configuration are intentionally separate:

- [`frontend/.env.example`](frontend/.env.example)
- [`backend/.env.example`](backend/.env.example)

Copy them only to ignored private environment files. Never fill an example file with real values.

## Local verification

Node.js 22 or newer is required. Docker is needed only for live Kubo testing.

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

There is no mock or local authentication bypass. Use a real Google development OAuth client and a disposable Postgres database for authenticated local development.

## Deploy the frontend

1. Create separate development and production databases or isolated branches on a PostgreSQL-compatible service.
2. Set the pooled owner URL as `DATABASE_URL` and run `npm --workspace frontend run db:migrate`.
3. Generate a base64url tenant password, set it temporarily as `ORBITCID_TENANT_PASSWORD`, and run `npm --workspace frontend run db:configure-tenant`. Build `TENANT_DATABASE_URL` with that restricted login.
4. Run `npm --workspace frontend run db:verify-isolation`.
5. Create a Google OAuth Web application with `/api/auth/callback/google` as the exact callback path.
6. Generate the grant-signing key with `npm --workspace frontend run key:generate`.
7. Import this repository into Vercel, set **Root Directory** to `frontend`, and add every value from [`frontend/.env.example`](frontend/.env.example) as Environment Variables.

Production deploys are created from the repository's `main` branch.

## Deploy and pair a backend

On a persistent Linux host with Docker:

```bash
cd infra/node
cp ../../backend/.env.example ../../backend/.env
# Fill only the exact frontend and backend origins plus operational limits.
docker compose --env-file ../../backend/.env up -d --build kubo agent
```

Expose `4001/TCP` and `4001/UDP` for the IPFS swarm. Keep `5001`, `8080`, and `8788` on loopback. Publish port `8788` through an HTTPS reverse proxy such as Caddy, nginx, or your hosting provider's private ingress; never expose Kubo RPC.

To pair the node:

1. Sign in to the Vercel frontend.
2. Create a named one-time pairing code.
3. Run `docker compose --env-file ../../backend/.env --profile pair run --rm pair` on the backend.
4. Paste the code at the terminal prompt and restart the agent.

The generated `pairing.json` stays in a private Docker volume. Revoking the connection prevents new grants; existing grants expire within five minutes.

## Optional Cloudflare R2 backup

R2 backup is opt-in per backend. In the signed-in console, select a paired backend and provide:

- Cloudflare account ID
- one existing private R2 bucket
- an R2 S3 access key restricted to Object Read & Write for that bucket
- backup prefix and retention period

The browser sends these values directly to the paired backend using a one-use `backup` grant. The hosted control plane receives no R2 credential. The backend encrypts its local configuration with AES-256-GCM using key material derived from its pairing identity. During backup, rclone crypt encrypts CAR contents and names before they reach R2.

Users who do not want R2 simply leave the feature unconfigured. Removing the configuration does not delete existing snapshots.

## Recovery and limitations

- Keep the backend pairing volume and an offline recovery copy secure; it is required to decrypt the saved R2 configuration and encrypted snapshots.
- Test a restore on a clean Kubo volume before relying on a backup.
- One Kubo node is recoverable but not highly available. Add an independent replica when uptime requirements justify it.
- Content published to public IPFS cannot be recalled from peers that copied it.

Read the full [deployment guide](docs/DEPLOYMENT.md) and [threat model](docs/THREAT_MODEL.md) before launch. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/0xmdrakib/OrbitCID/security/advisories/new).

## License

OrbitCID is available under the [MIT License](LICENSE).
