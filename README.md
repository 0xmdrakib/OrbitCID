# OrbitCID

Own your node. Control your orbit.

OrbitCID is a secure, open-source control surface that connects a signed-in web workspace to self-hosted Kubo IPFS infrastructure.

**Live app:** [https://ipfs.rakibhq.xyz](https://ipfs.rakibhq.xyz)

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Web application | Next.js, React, TypeScript |
| Identity | Google OAuth, Better Auth |
| Isolated control state | PostgreSQL with Row-Level Security |
| IPFS data plane | Kubo, UnixFS, CIDv1, libp2p, DHT, Bitswap |
| Backend bridge | Node.js, signed Ed25519 grants |
| Node packaging | Docker Compose |
| Optional offsite backup | S3-compatible object storage with client-owned encrypted credentials |

## Repository layout

| Path | Purpose |
| --- | --- |
| [`frontend`](frontend) | Next.js application, Google OAuth, tenant schema/isolation, pairing and grants |
| [`backend`](backend) | Portable pairing, grant verification, and encrypted R2 backup state |
| [`infra/node`](infra/node) | Docker Compose Kubo node, OrbitCID agent, backup and recovery tooling |
| [`docs`](docs) | Deployment and threat-model documentation |
| [`test`](test) | Pairing, grant, replay, tenant-isolation, and backup-security tests |

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

## Deploy a backend

On a persistent Linux host with Docker, create `backend/.env` from the example, add the required origins and operational limits, then start the node:

```bash
cd infra/node
cp ../../backend/.env.example ../../backend/.env
docker compose --env-file ../../backend/.env up -d --build kubo agent
```

| Port | Exposure |
| --- | --- |
| `4001/TCP + UDP` | Public IPFS swarm |
| `8788` | HTTPS reverse proxy or private ingress |
| `5001`, `8080` | Loopback only — never expose Kubo RPC |

### Pair with the frontend

1. Sign in to the hosted frontend and create a named one-time pairing code.
2. Run the pairing command on the backend:

   ```bash
   docker compose --env-file ../../backend/.env --profile pair run --rm pair
   ```

3. Paste the code at the prompt, then restart the agent.

The generated `pairing.json` remains in a private Docker volume. Revocation blocks new grants immediately; issued grants expire within five minutes.

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
