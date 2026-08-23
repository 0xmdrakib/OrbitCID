# Threat model

## Protected assets

- Private object and block bytes in R2
- Project ownership and visibility decisions
- Admin identity and password sessions
- Project API keys, IPNS signing material, recovery keys, and bridge credentials
- Availability and integrity of published roots

## Trust boundaries

- Browser to Cloudflare Access and Worker
- Project client to machine API
- Worker to D1, R2, Durable Objects, Queues, and Workflows
- Worker to Kubo bridge through Cloudflare Tunnel
- Kubo to the public IPFS network

## Primary threats and controls

| Threat | Control |
| --- | --- |
| Anonymous admin access | Cloudflare Access plus verified JWT and independent password session |
| Stolen database | Project and session secrets stored as peppered hashes; recovery exports encrypted |
| Cross-project CID discovery | Project ownership ledgers and project-scoped queries return `404` |
| SSRF during import | CID-only input and configured trustless gateway allowlist |
| Malformed CAR or DAG bomb | Root/hash verification, block size/count/depth limits, bounded imports |
| Gateway active content | Separate origin, no cookies, `nosniff`, sandbox CSP, immutable policy |
| Replay or brute force | Expiring signed tickets, single-use previews, atomic rate limits, scoped keys |
| Kubo API exposure | API and gateway bind to loopback; only swarm ports are public; bridge uses Tunnel and bearer auth |
| Accidental secret publication | Ignore rules, safe examples, release scanner, CI, and documented secret workflow |
| Public-content deletion expectation | Explicit acknowledgement that third-party IPFS copies cannot be recalled |

## Out of scope

- Deleting data already copied by third-party IPFS peers
- Protecting plaintext after an authorized client downloads it
- Compromise of the operator's Cloudflare, Google, or GitHub account
- Availability guarantees from a single Kubo node

Security-sensitive changes should add regression tests and update this document.
