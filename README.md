# OrbitCID

OrbitCID is a self-hosted IPFS storage and publishing platform for private files, public assets, and blockchain metadata.

**Self-hosted:** Every operator deploys their own dashboard, storage, and IPFS node. This repository does not provide a hosted service or shared public gateway.

---

## Overview

OrbitCID is built around two core layers:

- **Cloudflare control plane:** Handles verified uploads, project isolation, authentication, gateway access, and recovery metadata using Workers, R2, and D1.
- **Persistent Kubo data plane:** Runs on your Linux server and publishes explicitly public content through the IPFS DHT, Bitswap, and libp2p network.

With Kubo deployed and its swarm port reachable, published content can be retrieved by other IPFS peers without using the OrbitCID HTTP gateway. The Worker alone is an IPFS-compatible HTTP service, not a libp2p peer.

**Project status:** Pre-1.0. Start with private projects and complete staging, external-peer retrieval, and restore checks before enabling public publishing.

## Features

- Multiple projects with independent files, pins, API keys, quotas, and visibility settings
- Private-by-default storage with explicit project and per-CID publication controls
- CIDv1, SHA-256, UnixFS v1, fixed 1 MiB raw leaves, DAG-PB, DAG-CBOR, and CARv1 support
- Resumable multipart uploads with Worker-side block and root verification
- R2 streaming with Range requests, ETag, HEAD, and immutable caching
- Cloudflare Access Google login plus an independent, revocable admin-password session
- Named project API keys with scopes, expiry, rotation, and immediate revocation
- Client-side encrypted sealed vault with Argon2id and AES-256-GCM
- Mutable file paths, version history, rollback, and signed project-local stable links
- Trustless public-CID import with block-hash verification
- A portable Kubo primary node, with an optional second replica later
- Encrypted CAR backups and metadata recovery with provider-neutral offsite storage
- Responsive owner dashboard with project switching, reorderable navigation, activity, and integration examples

## Deployment options

| Layer | Where it runs |
| --- | --- |
| Dashboard | Worker assets, Cloudflare Pages, Vercel, or another static HTTPS host |
| API and metadata | Cloudflare Worker, D1, R2, Durable Objects, Queues, and Workflows |
| IPFS node | A suitable Linux VPS, dedicated server, or NAS with Docker |
| Offsite backup | An encrypted rclone remote on R2, AWS S3, Google Cloud Storage, or another supported backend |

The Kubo node is not tied to Google Cloud. A separate optional GCP Terraform root is included, while the portable Compose stack works with other server providers.

For a separately hosted dashboard, use a custom hostname under the same registrable domain as the API. Set `VITE_API_ORIGIN` and `DASHBOARD_ORIGIN` to the intended origins. Default cross-site `*.vercel.app` URLs are not supported for production admin sessions because the session cookie remains `SameSite=Strict`.

## Content behavior

### Private storage

- Projects start private, and anonymous gateway requests for private content return `404`.
- Project keys control access within their own namespace.
- Private content is not sent to public Kubo nodes.

### Public publishing

- Public content is verified before replication to the configured Kubo nodes.
- Use `ipfs://{cid}` for content-addressed references, including NFT images and metadata.
- The project gateway uses `https://gateway.example.com/{projectSlug}/ipfs/{cid}`.
- OrbitCID can unpin its own copies, but it cannot recall data already copied by third-party IPFS peers.

### Sealed vault

- Encryption and decryption happen in the browser.
- Plaintext metadata and decryption keys are not sent to Worker, R2, or Kubo.
- Publishing a sealed object exposes ciphertext, not the original file.

Stable links are project-local signed names; they are not published to the public IPNS DHT. Direct swarm, DHT, Bitswap, configuration, and daemon-control RPC commands are intentionally not exposed through the Worker facade.

## Tech stack

- TypeScript, React, and Vite
- Hono and Zod
- Cloudflare Workers, R2, D1, KV, Durable Objects, Queues, and Workflows
- Cloudflare Access and Analytics Engine
- Kubo, UnixFS, IPLD, and multiformats
- Argon2id and Web Crypto AES-GCM
- Docker Compose, Terraform, and rclone
- Vitest, GitHub Actions, and CodeQL

## Getting started

Use Node.js 22 or newer. Deployment also requires a Cloudflare account, an active DNS zone, R2, and a configured Access identity provider. Public IPFS publishing requires a persistent Linux server with Docker and reachable swarm networking.

```bash
git clone https://github.com/0xmdrakib/OrbitCID.git
cd OrbitCID
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
npm run security:release
```

To run the local Worker:

```bash
npm run dev
```

Local authentication bypasses are not included. The local page displays the Access gate; use an Access-protected staging hostname for authenticated end-to-end testing.

## Deployment

1. Provision the Cloudflare control plane and configure your own bindings, domains, and secrets.
2. Restrict admin access to your Google identity and configure the independent admin password.
3. Apply D1 migrations, then deploy the Worker and dashboard.
4. Deploy the portable Kubo stack or the optional GCP module, keeping RPC and its local gateway private.
5. Connect the authenticated node agent, configure offsite backups, and verify recovery before publishing.

The default swarm port is `4001/TCP+UDP`. Kubo RPC `5001` and its local gateway `8080` remain loopback-only on the host.

Detailed guides:

- [Deployment and configuration](docs/DEPLOYMENT.md)
- [Portable VPS node and backups](infra/node/README.md)
- [Optional Google Cloud node](infra/terraform-google/README.md)
- [Security boundaries and threat model](docs/THREAT_MODEL.md)

## API usage

Create a named key in **API & Integration** and keep it in your server-side environment. Never put project keys in a public frontend bundle.

```js
const form = new FormData();
form.append(
  "file",
  new Blob(["Hello, IPFS!"], { type: "text/plain" }),
  "hello.txt"
);

const response = await fetch("https://ipfs.example.com/api/v0/add?pin=true", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.ORBITCID_API_KEY}` },
  body: form
});

if (!response.ok) throw new Error(await response.text());

const records = (await response.text()).trim().split("\n").map(JSON.parse);
const cid = records.at(-1).Hash;
console.log(`ipfs://${cid}`);
```

The API key determines the project. A returned CID is not automatically public: its project and content visibility settings still apply. The dashboard includes additional cURL, resumable-upload, and NFT metadata examples.

## Backup and recovery

R2 retains verified content, while Kubo serves published roots over the public IPFS network.

- **Node loss:** Rebuild Kubo from verified content or checksummed CAR snapshots.
- **R2 retrieval failure:** The Worker can try its authenticated Kubo fallback for content retained on a configured node.
- **Control-plane recovery:** Restore encrypted metadata snapshots together with the required R2 blocks and objects.
- **Offsite copies:** Keep backup credentials and recovery keys separate from the primary provider account.

A daily systemd timer is included for CAR backups. Monitor failed runs and stale snapshots, and test restoration on a clean node.

One node is recoverable, but it is not high availability. Add the optional second replica when uninterrupted public-network availability becomes important.

## Security and maintenance

- Keep real `.env`, `.dev.vars`, deploy-time `.tfvars`, Terraform state, and credentials out of Git.
- Use scoped cloud tokens and independent secrets for each purpose; a Cloudflare Global API Key is not required.
- Keep Kubo RPC private and the public gateway separate from the admin origin.
- Review dependency updates and monitor quotas, abuse, backup health, and billing.
- Complete staging checks before treating an installation as production-ready.

Security fixes target the latest `main` branch. Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/0xmdrakib/OrbitCID/security/advisories/new), not a public issue.

Contributions are welcome. Keep pull requests focused, run the verification commands above, add tests for affected behavior, and explain any security or migration impact. Changes must preserve authentication, project isolation, CID verification, and recovery integrity.

---

## License

This project is licensed under the [MIT License](./LICENSE).
