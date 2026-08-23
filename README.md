# OrbitCID

OrbitCID is a secure, self-hosted IPFS storage and publishing platform. A Cloudflare control plane provides verified uploads, project isolation, authentication, gateway acceleration, and recovery metadata; a persistent Kubo data plane on the operator's server provides the real IPFS WAN DHT, Bitswap, libp2p, pinning, and public content advertisement.

The repository contains no hosted service URL and no shared public gateway. Every operator deploys an independent installation. The dashboard can share the Worker origin or run as a static application on Vercel, Cloudflare Pages, or another static host. Kubo can run on GCP, AWS, Azure, DigitalOcean, Hetzner, a dedicated server, NAS, or any suitable Linux VPS.

## Why OrbitCID

- Project isolation with separate keys, quotas, files, pins, stable links, audit events, and gateway policies
- Private-by-default R2 storage with explicit per-project and per-CID publication controls
- CIDv1, SHA-256, UnixFS v1, raw leaves, DAG-PB, DAG-CBOR, and CARv1 support
- Resumable multipart uploads without full-file buffering in the Worker
- Fast direct R2 object streaming with Range, ETag, HEAD, and immutable caching
- Cloudflare Access Google identity plus an independent revocable password session
- Named, scoped, expiring, rotatable, immediately revocable project API keys
- Client-side Argon2id and AES-256-GCM sealed vault mode
- Portable real Kubo primary node; a second replica can be enabled later without changing URLs or keys
- Encrypted, provider-neutral CAR backups through rclone to R2, AWS S3, GCS, or other supported storage
- Private Worker-to-Kubo fallback retrieval when the object-storage path is unavailable
- Warm, responsive owner dashboard with copy-ready JavaScript, cURL, resumable, and NFT integration examples

## Architecture

```text
Owner / project client
        |
        v
Dashboard (same Worker, Vercel, Pages, or static host)
        |
        v
Cloudflare Access + OrbitCID API Worker
        |--- D1 metadata, sessions, projects, pins, audit
        |--- R2 verified blocks, objects, staging, recovery
        |--- Durable Objects for locks and rate limits
        |--- Queues / Workflows for verification and replication
        |
        +--- signed CAR delivery ---> private node agent ---> persistent Kubo
                                                        |-- WAN DHT / Bitswap / libp2p
                                                        |-- local fallback gateway
                                                        +-- encrypted CAR snapshots ---> R2 / S3 / GCS / other remote
```

The two data paths are intentional. R2 keeps a verified recovery and fast-gateway copy; Kubo is the network-facing IPFS data plane for explicitly public roots. If R2 retrieval fails, the Worker can fall back through the authenticated node agent. If the Kubo server is lost, it can be rebuilt from Worker-managed content or encrypted CAR snapshots.

## Is this true IPFS?

**Yes, when the Kubo data plane is deployed and reachable on swarm port 4001/TCP+UDP.** Kubo joins the public Amino DHT, advertises pinned CIDs, and exchanges blocks with other peers through Bitswap. A third-party IPFS peer can retrieve published content without using the OrbitCID HTTP gateway.

The Worker by itself remains an IPFS-compatible HTTP control plane, not a libp2p peer. It intentionally returns `501 NOT_SUPPORTED` for direct swarm, DHT, Bitswap, P2P, config, and daemon-control commands. OrbitCID never disguises this boundary.

## Deployment choices

| Layer | Supported placement | Purpose |
| --- | --- | --- |
| Dashboard | Worker assets, Vercel, Cloudflare Pages, any static HTTPS host | Owner UI only |
| API/control plane | Cloudflare Worker, D1, R2, Durable Objects, Queues/Workflows | Auth, policy, verification, fast gateway, recovery |
| IPFS data plane | Any stable Linux VPS/server with Docker, or the optional GCP Terraform module | Real Kubo DHT/Bitswap/libp2p node |
| Backup | Encrypted rclone remote over R2, AWS S3, Google Cloud Storage, or another backend | Portable CAR snapshots and disaster recovery |

For a separate dashboard host, use a custom HTTPS hostname under the same registrable domain as the API, set `VITE_API_ORIGIN` at build time, and set the Worker's `DASHBOARD_ORIGIN` to that exact origin. This same-site requirement preserves the strict admin-session cookie; a default cross-site `*.vercel.app` hostname is intentionally unsupported for authenticated production sessions. Protect both origins with the intended Cloudflare Access policy. API keys belong only in server-side applications, never in a public frontend bundle.

## Security model

- The admin hostname belongs behind a Cloudflare Access application restricted to the operator's identity provider account.
- OrbitCID verifies the Access JWT signature, issuer, audience, expiry, and exact allowed email again inside the Worker.
- The second login layer creates a random, hashed, revocable D1 session in a `Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` cookie.
- Project machine routes accept only project-bound API keys with the required scope. Secrets are shown once and stored only as peppered hashes.
- Public gateway routes never receive admin cookies and return `404` for private, deleted, disabled, or unowned content.
- Upload blocks, imported CAR blocks, root CIDs, codecs, DAG links, and replication roots are verified before publication.
- Login, mutation, and public gateway limits use atomic Durable Object counters.
- Sealed-vault keys and plaintext never leave the browser.

See [SECURITY.md](SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before operating a public gateway.

## Requirements

- Node.js 22 or newer
- A Cloudflare account and active DNS zone
- R2 enabled in that account
- Cloudflare Access with a Google or other supported identity provider
- Terraform 1.7+ for the provided infrastructure, or equivalent manual provisioning
- A persistent Linux server with at least 2 CPU cores, 6-8 GB RAM, adequate SSD capacity, and a reachable public swarm port for true IPFS mode
- Optional: a billing-enabled Google Cloud project when using the provided infrastructure module
- Optional but strongly recommended: an encrypted rclone remote for off-server CAR backups

Workers Free can be used for development or light personal workloads. A paid Workers plan is optional and provides additional production headroom; OrbitCID does not require it merely to start.

## Local verification

Local authentication bypasses are intentionally not included. Protocol and UI builds can be tested without weakening production authentication:

```powershell
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
npm run security:release
```

To test the authenticated dashboard end-to-end, use a staging hostname protected by Cloudflare Access.

## Deployment overview

1. Deploy the dashboard on the Worker origin or build it for Vercel/Pages with `VITE_API_ORIGIN`.
2. Create the Cloudflare control-plane resources with Terraform or manually, replace the safe placeholders in `wrangler.jsonc`, and store independent secrets.
3. Apply D1 migrations and deploy the Worker API. Protect its admin routes with Cloudflare Access; leave only the isolated public gateway anonymous.
4. Deploy `infra/node` on any suitable VPS, or use the separate optional `infra/terraform-google` root. Keep Kubo RPC and its local gateway private; expose only swarm `4001/TCP+UDP`.
5. Connect the node agent through Cloudflare Tunnel using a unique bridge token.
6. Configure an encrypted rclone remote, run a CAR backup, and prove restore on a clean node.
7. Start with all projects private. Enable public publishing only after Worker, Kubo, external-peer retrieval, fallback, and backup health checks pass.

Full instructions are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), with the portable VPS stack documented in [infra/node/README.md](infra/node/README.md).

## Failure model

- **Dashboard host fails:** redeploy the static build elsewhere; stored content and Kubo remain unaffected.
- **Worker/API fails:** Kubo continues serving already published CIDs over the IPFS network.
- **R2 retrieval fails:** authorized requests can fall back to the primary Kubo gateway through the private agent.
- **Kubo VM fails:** the Cloudflare gateway copy continues serving permitted content while the node is rebuilt from CAR backups or verified control-plane storage.
- **VPS disk is lost:** restore timestamped, checksummed CAR snapshots to a fresh Kubo repo.
- **Single provider account is compromised:** no application can guarantee recovery; use separate providers, MFA/passkeys, offline recovery credentials, billing alerts, and tested backups.

A single Kubo node is resilient and recoverable, but it is not high availability. Enable the optional second node when continuous public-network availability becomes important.

## Project API example

Create a named project key in **API & Integration**, then keep it in server-side environment variables:

```js
const form = new FormData();
form.append("file", file);

const response = await fetch("https://ipfs.example.com/api/v0/add?pin=true", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.ORBITCID_API_KEY}` },
  body: form
});

if (!response.ok) throw new Error(await response.text());
const records = (await response.text()).trim().split("\n").map(JSON.parse);
const cid = records.at(-1).Hash;
```

Public project content uses a stable canonical URL:

```text
https://gateway.example.com/{projectSlug}/ipfs/{cid}
```

Use `ipfs://{cid}` inside NFT or blockchain metadata. The HTTP gateway is a retrieval path, not a replacement for the content-addressed URI.

## Data and compatibility policy

- CIDv1 Base32
- SHA-256 multihash
- UnixFS v1
- Fixed 1 MiB chunks
- Raw leaves
- DAG-PB directories and file roots
- DAG-CBOR private manifests
- CARv1 import/export

The Kubo-compatible facade includes `add`, `cat`, `get`, `ls`, `block/get`, `block/stat`, `dag/get`, `dag/import`, `dag/export`, `pin/add`, `pin/ls`, and private name resolution where applicable.

## Public IPFS warning

Publishing to Kubo makes content available to the public IPFS network. OrbitCID can remove its own gateway authorization and unpin from its own nodes, but it cannot delete copies already retained by third-party peers. Do not publish confidential plaintext. Public sealed content exposes ciphertext only, but availability and traffic metadata may still be observable.

## Operator references

- [Install and operate Kubo](https://docs.ipfs.tech/install/command-line/)
- [Kubo RPC security](https://docs.ipfs.tech/reference/kubo/rpc/)
- [IPFS nodes, DHT, and Bitswap](https://docs.ipfs.tech/concepts/nodes/)
- [IPFS privacy and encryption](https://docs.ipfs.tech/concepts/privacy-and-encryption/)
- [rclone crypt](https://rclone.org/crypt/)
- [rclone S3 providers, including R2, AWS, and GCS](https://rclone.org/s3/)
- [rclone Google Cloud Storage backend](https://rclone.org/googlecloudstorage/)

## License

This project is licensed under the [MIT License](./LICENSE).

© 2026 Md. Rakib • made with love and passion.
