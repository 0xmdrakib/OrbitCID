# Security Policy

## Supported versions

OrbitCID is pre-1.0 software. Security fixes are applied to the latest commit on the default branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting feature on the repository's **Security** tab. Include the affected route or component, reproduction steps, impact, and any suggested mitigation.

Please allow a reasonable period for investigation before public disclosure. Confirmed reports will receive a remediation plan and coordinated disclosure timeline.

## Deployment responsibilities

Self-hosters are responsible for protecting their Cloudflare and Google Cloud accounts, restricting Cloudflare Access to intended identities, keeping secrets out of Git, applying updates, monitoring usage, and understanding that publicly published IPFS content may be copied permanently by third-party peers.

OrbitCID never needs a Cloudflare Global API Key. Use narrowly scoped API tokens and separate secrets for sessions, project keys, recovery encryption, IPNS signing, replication tickets, and every Kubo bridge.
