# Threat model

## Protected assets

- Google-linked account identity and revocable sessions
- Per-user backend connection state, preferences, and activity rows in Neon
- Frontend grant-signing private key
- Backend pairing private key and emergency bridge credential
- Private IPFS content and Kubo pin state
- Encrypted CAR backups and their independent recovery keys
- Optional Cloudflare provider content, project ownership, and publication decisions

## Trust boundaries

- Browser to Vercel and Better Auth
- Vercel functions to Neon owner and restricted tenant roles
- Browser to the user-selected HTTPS backend
- Pairing client to the one-time Vercel claim endpoint
- OrbitCID agent to loopback/container-only Kubo RPC
- Kubo to libp2p, DHT, Bitswap, and the public IPFS network
- Backup job to a separately credentialed storage provider

## Primary threats and controls

| Threat | Control |
| --- | --- |
| Anonymous private action | Server-validated Better Auth session is required; the public page remains read-only |
| OAuth login CSRF or code injection | Better Auth state, PKCE, exact callbacks, trusted origins, HttpOnly/Secure/SameSite cookies |
| User A reads or changes user B | Server-derived user ID on every route, parameterized queries, restricted DB role, forced Postgres RLS |
| Browser steals permanent backend credentials | No permanent backend credential is placed in JavaScript or localStorage; five-minute scoped grants are used |
| Backend is paired by an attacker | 256-bit single-use claim, ten-minute expiry, Ed25519 proof of possession, atomic claim consumption |
| Grant used against another backend | JWT `aud` is the immutable backend connection ID and is checked by the agent |
| Grant used as another user | JWT `sub` must match the owner bound in local pairing configuration |
| Grant scope escalation | Agent checks the required scope for every route; Kubo RPC itself remains private |
| Mutation replay | Unique JWT ID is consumed once for upload/pin mutations and expires with the grant |
| Cross-origin browser request | Exact paired frontend origin in CORS; no wildcard with credentials; Vercel mutations verify same origin |
| Kubo API exposure | RPC and local gateway bind to loopback/container networking; only the agent and Kubo swarm are reachable |
| Oversized upload/CAR | Declared and streamed byte limits, bounded request JSON, Kubo-side chunking, timeouts |
| Path traversal or CID confusion | Strict CID/path parsing, rejected dot/backslash/NUL segments, no arbitrary filesystem path input |
| Pairing SSRF | Backend claims outbound to Vercel; Vercel does not fetch the user-supplied backend URL during pairing |
| Database credential disclosure | Separate owner/tenant URLs, production-only Vercel secrets, no client exposure, provider rotation procedure |
| VPS disk loss | Persistent volumes plus checksummed CAR export to encrypted off-provider storage |
| Backup provider disclosure | rclone crypt encrypts names and content before transfer; credentials and encryption password are separate |
| Public-content deletion expectation | Documentation warns that third-party IPFS peers can retain already published bytes |
| Accidental secret publication | Ignore rules, blank examples, release scanner, CI, CodeQL, and no tracked runtime pairing file |

## Important residual risks

- A compromised authorized browser session can perform actions available to that user until revoked.
- A compromised Vercel grant-signing key can mint grants; rotate the key, revoke connections, and re-pair backends.
- A compromised backend can read content stored on that backend and use its local Kubo identity.
- RLS protects application access through the restricted role; the Neon database owner remains a privileged recovery role.
- A single Kubo node cannot provide high availability during host, disk, or network failure.
- Content published to public IPFS cannot be recalled from independent peers.

## Out of scope

- Protecting plaintext after an authorized user downloads or decrypts it
- Deleting data already copied by third-party IPFS peers
- Compromise of the operator's Google, Vercel, Neon, cloud-provider, or GitHub account
- Availability guarantees from a single-node deployment

Security-sensitive changes must add a regression test and update this document when a boundary changes.
