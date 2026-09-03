# Changelog

All notable changes will be documented here. This project follows semantic versioning after the first stable release.

## Unreleased

- Added a public Next.js frontend for Vercel with Google sign-in, profile avatars, and protected console actions.
- Added Neon Better Auth storage, restricted tenant role, forced RLS policies, and an automated cross-tenant isolation check.
- Added one-time Ed25519 backend pairing and five-minute user/audience/scope-bound grants.
- Added direct browser-to-Kubo uploads, recursive pin management, exact-origin CORS, mutation replay defense, and tenant activity records.
- Split the reusable Vercel frontend and portable trust bridge into `frontend` and `backend` folders while retaining the Cloudflare provider profile.
- Renamed the project to OrbitCID for its public open-source release.
- Added project-scoped APIs, canonical public gateway routing, key rotation, and usage isolation.
- Replaced development authentication with verified Cloudflare Access plus revocable D1 admin sessions.
- Added Durable Object rate limiting and signed replication CAR delivery.
- Added a project-aware dashboard and copy-ready integration guide.
