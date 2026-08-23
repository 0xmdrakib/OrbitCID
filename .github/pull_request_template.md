## Summary

Describe the change and the problem it solves.

## Security and data isolation

- [ ] Project authorization and public/private behavior are unchanged or covered by tests.
- [ ] No secrets, account identifiers, domains, state files, or generated assets are included.
- [ ] Migration and rollback impact is documented.

## Verification

- [ ] `npm run security:release`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm audit --omit=dev`
