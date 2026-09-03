# Threat model

## Protected assets

- Google-linked identities and revocable sessions
- Per-user connection, preference, and activity rows in the control database
- Frontend grant-signing private key
- Backend pairing private key and Kubo pin state
- Optional R2 credentials and encrypted CAR snapshots

## Trust boundaries

- Browser to Vercel and Better Auth
- Hosted functions to privileged and restricted database roles
- Browser to the selected HTTPS backend
- Pairing client to the one-time Vercel claim endpoint
- OrbitCID agent to private Kubo RPC
- Kubo to libp2p, DHT, Bitswap, and public peers
- OrbitCID agent to an optional private R2 bucket

## Threats and controls

| Threat | Control |
| --- | --- |
| Anonymous private action | Verified Better Auth session required; public UI is read-only |
| OAuth CSRF/code injection | State, PKCE, exact callbacks, trusted origins, secure HttpOnly cookies |
| Cross-tenant database access | Server-derived user ID, parameterized queries, restricted role, forced RLS |
| Permanent credential theft from browser | Only five-minute scoped grants enter JavaScript; no backend or R2 secret is persisted by the frontend |
| Backend hijacking during pairing | 256-bit one-use claim, ten-minute expiry, Ed25519 proof, atomic consumption |
| Grant used for another user/node | Agent validates `sub`, `aud`, issuer, signature, expiry, and scope |
| Mutation replay | Agent consumes the grant's unique ID once within its lifetime |
| Cross-origin backend call | Exact paired origin in CORS; no credentialed wildcard |
| Kubo RPC exposure | RPC and local gateway stay on loopback/container networking |
| Oversized input | Declared and streamed upload limits, bounded JSON, timeouts |
| Path traversal/CID confusion | Strict CID/path parsing and rejection of dot, backslash, and NUL segments |
| R2 secret disclosure | Direct browser-to-backend delivery, one-use backup grant, AES-256-GCM local envelope, no secret in control data, activity, or status |
| R2 account overreach | Documentation and UI require bucket-scoped Object Read & Write credentials, never a global key |
| R2 object disclosure | Private bucket plus rclone crypt content and filename encryption |
| Backend disk loss | Persistent storage plus encrypted offsite CAR snapshots and restore testing |
| Accidental publication | Blank examples, ignore rules, release scanner, CI, CodeQL |

## Residual risks

- A compromised authorized browser session can use that user's granted actions until revoked.
- A compromised Vercel signing key can mint grants; revoke connections, rotate the key, and re-pair.
- Root compromise of the backend can access Kubo data and pairing-derived backup material.
- Losing the backend pairing identity can make encrypted R2 snapshots unrecoverable.
- Control-database owners bypass the restricted application role and remain privileged recovery operators.
- One Kubo node cannot provide availability during host, disk, or network failure.
- Public IPFS content cannot be recalled from independent peers.

Security-boundary changes require a regression test and an update to this document.
