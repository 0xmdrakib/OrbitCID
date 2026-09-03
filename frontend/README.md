# OrbitCID frontend

The frontend is a Next.js application designed for Vercel. Its public page is inspectable without an account; connection, upload, pin, and activity operations require Google sign-in.

## Responsibilities

- Better Auth Google OAuth and revocable database sessions
- Google profile/avatar navigation
- Neon tenant state and forced RLS
- one-time backend pairing claims
- short-lived, scoped backend grants
- direct browser-to-backend upload and pin controls

It does not store IPFS file bytes or permanent backend credentials.

## Setup

```bash
cp .env.example .env.local
npm run key:generate
npm run db:migrate
npm run db:verify-isolation
npm run dev
```

Fill the private environment locally and in Vercel. The Google callback is `/api/auth/callback/google`. Use exact origins; do not expose any secret through a `NEXT_PUBLIC_` variable.

See the root [deployment guide](../docs/DEPLOYMENT.md) for Neon role setup, Google OAuth, Vercel, backend pairing, and production acceptance.
