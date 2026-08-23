# Contributing to OrbitCID

Thank you for helping improve OrbitCID.

1. Fork the repository and create a focused branch.
2. Do not commit `.dev.vars`, `.tfvars`, state files, account IDs, domains, email addresses, tokens, generated dashboard assets, or Wrangler state.
3. Run `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev`, and `npm run security:release`.
4. Add tests for protocol, authorization, or data-isolation changes.
5. Explain security and migration impact in the pull request.

Changes that weaken CID verification, project isolation, authentication, public/private visibility boundaries, or secret handling will not be accepted.
