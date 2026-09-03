# OrbitCID frontend

The frontend is a Next.js application designed for Vercel. Its public page is inspectable without an account; connection, upload, pin, and activity operations require Google sign-in.

## Responsibilities

- Better Auth Google OAuth and revocable database sessions
- Google profile/avatar navigation
- tenant-isolated control state and enforced row-level security
- one-time backend pairing claims
- short-lived, scoped backend grants
- direct browser-to-backend upload and pin controls
- optional R2 backup configuration sent directly to the selected backend

It does not store IPFS file bytes, R2 credentials, or permanent backend credentials.
