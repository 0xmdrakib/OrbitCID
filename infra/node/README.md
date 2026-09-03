# Portable OrbitCID node

This stack runs Kubo and the OrbitCID agent on any suitable Docker host.

## Services

- `kubo` — persistent IPFS node, WAN DHT, Bitswap, local gateway and private RPC
- `agent` — narrow authenticated API plus optional encrypted R2 backup runner
- `pair` — one-shot client that binds the node to a Google-authenticated user
- `backup` — manual provider-neutral CAR backup/restore utility for operators who supply their own encrypted rclone configuration

Only swarm port `4001/TCP+UDP` is public. Ports `5001`, `8080`, and `8788` bind to host loopback. Put only the agent behind an HTTPS reverse proxy.

```bash
cp ../../backend/.env.example ../../backend/.env
docker compose --env-file ../../backend/.env up -d --build kubo agent
docker compose --env-file ../../backend/.env --profile pair run --rm pair
docker compose --env-file ../../backend/.env up -d agent
```

The pairing code is entered interactively and is not written to Compose environment variables. The private pairing record and AES-256-GCM R2 configuration stay in `agent-staging`.

## Optional R2 backup

Configure R2 from the signed-in frontend. The agent image includes rclone and executes an encrypted CAR backup without exposing credentials to Vercel or Neon. Preserve the pairing volume because its private key is required to derive the backup encryption key.

Restore the latest frontend-managed R2 snapshot, or provide an explicit timestamp:

```bash
docker compose --env-file ../../backend/.env exec agent node /app/backend/r2-restore.mjs
docker compose --env-file ../../backend/.env exec agent node /app/backend/r2-restore.mjs 20260824T120000Z
```

The separate `backup` profile remains available for advanced provider-neutral rclone recovery. Mount an encrypted `rclone.conf`, set `RCLONE_REMOTE`, and run it only after reviewing the scripts:

```bash
docker compose --env-file ../../backend/.env --profile backup run --rm backup
docker compose --env-file ../../backend/.env --profile backup run --rm --entrypoint /usr/local/bin/restore.sh backup
```

Always test restore on a clean volume. A completed upload is not proof of recoverability.
