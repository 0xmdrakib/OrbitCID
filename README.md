# OrbitCID

OrbitCID is a secure, self-hosted IPFS-compatible storage and publishing platform built for Cloudflare. It combines verified CIDv1/UnixFS storage, private project namespaces, an owner dashboard, authenticated machine APIs, CAR import/export, and an optional persistent Kubo node for publishing selected content to the public IPFS network.

The repository contains no hosted service URL and no shared public gateway. Every operator deploys an independent installation under their own Cloudflare and Google Cloud accounts.

## Why OrbitCID

- Project isolation with separate keys, quotas, files, pins, stable links, audit events, and gateway policies
- Private-by-default R2 storage with explicit per-project and per-CID publication controls
- CIDv1, SHA-256, UnixFS v1, raw leaves, DAG-PB, DAG-CBOR, and CARv1 support
- Resumable multipart uploads without full-file buffering in the Worker
- Fast direct R2 object streaming with Range, ETag, HEAD, and immutable caching
- Cloudflare Access Google identity plus an independent revocable password session
- Named, scoped, expiring, rotatable, immediately revocable project API keys
- Client-side Argon2id and AES-256-GCM sealed vault mode
- Optional single Kubo primary node; a second replica can be enabled later without changing URLs or keys
- Warm, responsive owner dashboard with copy-ready JavaScript, cURL, resumable, and NFT integration examples

## Architecture

```text
Owner / project client
        |
        v
Cloudflare Access + OrbitCID Worker
        |--- D1 metadata, sessions, projects, pins, audit
        |--- R2 verified blocks, objects, staging, recovery
        |--- Durable Objects for locks and rate limits
        |--- Queues / Workflows for verification and replication
        |
        +--- optional signed CAR delivery ---> private bridge ---> Kubo ---> public IPFS
```

R2 is authoritative. The optional Kubo node is a public-network replica for content that an operator explicitly publishes. The Worker itself is not a libp2p peer and intentionally returns `501 NOT_SUPPORTED` for swarm, DHT, Bitswap, P2P, config, and daemon-control commands.

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
- Optional: a billing-enabled Google Cloud project for public Kubo replication

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

1. Copy the Terraform example and set your own account, zone, domain, allowed identity, project, and generated bridge token.
2. Apply the Terraform configuration to create private R2 buckets, D1, KV, Queues, Access policies, Tunnel, and the optional Kubo primary.
3. Replace the D1 and KV placeholder IDs and example hostnames in `wrangler.jsonc` with your Terraform outputs.
4. Generate independent production secrets and store them with `wrangler secret put`.
5. Build the dashboard, apply remote migrations, and deploy the Worker.
6. Attach the admin and gateway custom domains. Keep the gateway outside Cloudflare Access; keep the admin hostname protected.
7. Start with all projects private. Enable public publishing only after the gateway and Kubo health checks pass.

Full instructions are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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

## License

OrbitCID is available under the [MIT License](LICENSE).

© 2026 Md. Rakib — made with love and passion.
