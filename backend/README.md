# OrbitCID backend

This folder contains the portable trust bridge between the Vercel frontend and a persistent Kubo node. It can run on a PC, VPS, dedicated server, or cloud VM. IPFS content never passes through Vercel or Neon.

## Security model

- Kubo RPC and the local gateway bind to loopback/container networking only.
- The public backend endpoint must use HTTPS through Cloudflare Tunnel, Caddy, nginx, or an equivalent reverse proxy.
- Pairing uses a 256-bit, ten-minute, single-use claim and an Ed25519 proof of possession.
- Browser requests use five-minute Ed25519-signed grants bound to one user, one backend audience, and explicit scopes.
- Mutation grant IDs are consumed once by the agent to limit replay.
- The emergency `BRIDGE_TOKEN` is never sent to the browser.

## Pairing

1. Copy `.env.example` to a private `.env` and fill the frontend origin, backend HTTPS URL, and a generated bridge token.
2. Start the node with the Compose file in [`../infra/node`](../infra/node).
3. Sign in to the Vercel frontend and create a pairing code.
4. Run `docker compose --profile pair run --rm pair` from `infra/node` and paste the code at the prompt.
5. Restart the agent with `docker compose up -d agent` and test it from the frontend console.

The generated `pairing.json` remains inside the private Docker volume. Do not copy it into Git or an image.
