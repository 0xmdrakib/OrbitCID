# OrbitCID backend

This folder contains the portable trust layer between the hosted frontend and a persistent Kubo node. It can run on a PC, VPS, NAS, dedicated server, or cloud VM. IPFS bytes never pass through the hosted control plane.

## Responsibilities

- one-time Ed25519 backend pairing
- short-lived user/backend/scope grant verification
- exact-origin streaming upload, retrieval, and pin operations
- optional encrypted Cloudflare R2 backup configuration
- no direct exposure of Kubo RPC

R2 credentials are sent directly from the signed-in browser to the paired backend, sealed locally with AES-256-GCM, and never stored in the control database. Backup CAR data and filenames are encrypted before upload.

Copy [`backend/.env.example`](.env.example) only to an ignored private `.env`. Deployment commands are in [`infra/node`](../infra/node) and the root [deployment guide](../docs/DEPLOYMENT.md).
