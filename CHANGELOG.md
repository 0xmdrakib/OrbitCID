# Changelog

All notable changes are documented here. Semantic versioning begins with the first stable release.

## Unreleased

- Added a public Next.js frontend for Vercel with Google sign-in, profile avatars, and protected console actions.
- Added Neon Better Auth storage, a restricted tenant role, forced RLS, and cross-tenant isolation verification.
- Added one-time Ed25519 backend pairing and five-minute user/audience/scope-bound grants.
- Added direct browser-to-Kubo uploads, recursive pin management, exact-origin CORS, replay defense, and tenant activity records.
- Split reusable frontend and portable backend configuration into independent folders and blank environment examples.
- Added optional per-backend Cloudflare R2 backup configured from the frontend without storing R2 credentials in Vercel or Neon.
- Added AES-256-GCM local credential sealing and rclone crypt encryption for offsite CAR snapshots.
- Removed the former Worker/D1 provider, provider dashboard, and related deployment profile.
